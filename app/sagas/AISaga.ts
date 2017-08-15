import { channel as makeChannel, Channel, eventChannel, Task } from 'redux-saga'
import { all, fork, put, select, spawn, take } from 'redux-saga/effects'
import { getDirectionInfo, spawnTank } from 'utils/common'
import directionController from 'sagas/directionController'
import fireController from 'sagas/fireController'
import * as selectors from 'utils/selectors'
import { State } from 'reducers/index'
import { TankRecord, PlayerRecord } from 'types'

const AIWorker = require('worker-loader!ai/worker')

function* handleCommands(playerName: string, commandChannel: Channel<AICommand>, noteChannel: Channel<Note>) {
  let fire = false
  let nextDirection: Direction = null
  let forwardLength = 0
  let startPos: number

  yield fork(directionController, playerName, getAIInput)
  yield fork(fireController, playerName, () => {
    if (fire) {
      fire = false
      return true
    } else {
      return false
    }
  })
  yield fork(function* notifyWhenBulletComplete() {
    while (true) {
      const { bullets }: Action.DestroyBulletsAction = yield take('DESTROY_BULLETS')
      const tank = yield select(selectors.playerTank, playerName)
      if (tank != null) {
        if (bullets.some(b => (b.tankId === tank.tankId))) {
          console.debug('bullet-completed. notify')
          noteChannel.put({ type: 'bullet-complete' })
        }
      }
    }
  })

  while (true) {
    const command: AICommand = yield take(commandChannel)
    if (command.type === 'forward') {
      const tank = yield select(selectors.playerTank, playerName)
      if (tank == null) {
        continue
      }
      const { xy } = getDirectionInfo(tank.direction)
      startPos = tank.get(xy)
      forwardLength = command.forwardLength
    } else if (command.type === 'fire') {
      fire = true
    } else if (command.type === 'turn') {
      nextDirection = command.direction
    } else if (command.type === 'query') {
      if (command.query === 'my-tank') {
        const tank: TankRecord = yield select(selectors.playerTank, playerName)
        noteChannel.put({
          type: 'query-result',
          result: {
            type: 'my-tank-info',
            tank: tank && tank.toObject(),
          },
        })
      } else if (command.query === 'map') {
        const { map }: State = yield select()
        noteChannel.put({
          type: 'query-result',
          result: { type: 'map-info', map: map.toJS() },
        })
      } else if (command.query === 'tanks') {
        const { tanks }: State = yield select()
        noteChannel.put({
          type: 'query-result',
          result: {
            type: 'tanks-info',
            tanks: tanks.map(t => t.toObject()).toArray(),
          },
        })
      } else if (command.query === 'my-fire-info') {
        const tank: TankRecord = yield select(selectors.playerTank, playerName)
        console.assert(tank != null, 'tank is null when query `my-fire-info`')
        const { cooldowns, bullets }: State = yield select()
        const cooldown = cooldowns.get(tank.tankId)
        const bulletCount = bullets.filter(b => b.tankId === tank.tankId).count()
        const canFire = bulletCount < tank.bulletLimit && cooldown <= 0
        noteChannel.put({
          type: 'query-result',
          result: {
            type: 'my-fire-info',
            bulletCount,
            canFire,
            cooldown,
            bulletLimit: tank.bulletLimit,
          },
        })
      }
    } else {
      throw new Error()
    }
  }

  function* getAIInput() {
    const tank = yield select(selectors.playerTank, playerName)
    if (tank == null) {
      return null
    }
    // fixme 转向的时候会将当前前进的信息清除, 导致转向命令和前进命令不能共存
    if (nextDirection && tank.direction !== nextDirection) {
      const direction = nextDirection
      nextDirection = null
      forwardLength = 0
      return { type: 'turn', direction }
    } else if (forwardLength > 0) {
      const { xy } = getDirectionInfo(tank.direction)
      const movedLength = Math.abs(tank.get(xy) - startPos)
      const maxDistance = forwardLength - movedLength
      if (movedLength === forwardLength) {
        forwardLength = 0
        noteChannel.put({ type: 'reach' })
        return null
      } else {
        return {
          type: 'forward',
          maxDistance,
        }
      }
    }
    return null
  }
}

function* sendNotes(worker: Worker, noteChannel: Channel<Note>) {
  yield fork(function* sendNote() {
    while (true) {
      const note: Note = yield take(noteChannel)
      worker.postMessage(note)
    }
  })
}

interface WorkerConstructor {
  new(): Worker
}

/**
 * AIWorkerSaga对应一个正在游戏中的AI玩家.
 * 当一个AI玩家坦克创建/激活时, 一个AIWorkerSaga实例将被创建
 * 当AI玩家的坦克被击毁时, saga实例将停止运行
 * 一个AIWorkerSaga实例总是对应一个正在游戏中的AI玩家坦克
 *
 * 在创建AiWorkerSaga的过程中, 将创建worker对象,
 * 并将创建noteChannel和commandChannel
 * 游戏逻辑和AI逻辑使用这两个channel来进行数据交换
 */
function* AIWorkerSaga(playerName: string, WorkerClass: WorkerConstructor) {
  const worker = new WorkerClass()
  try {
    // noteChannel用来向AI程序发送消息/通知
    const noteChannel = makeChannel<Note>()
    // commandChannel用来从AI程序获取command
    const commandChannel = eventChannel<AICommand>((emitter) => {
      const listener = (event: MessageEvent) => emitter(event.data)
      worker.addEventListener('message', listener)
      return () => worker.removeEventListener('message', listener)
    })

    yield all([
      handleCommands(playerName, commandChannel, noteChannel),
      sendNotes(worker, noteChannel),
    ])
  } finally {
    worker.terminate()
  }
}

/** AIMasterSaga用来管理AIWorkerSaga的启动和停止, 并处理和AI程序的数据交互 */
export default function* AIMasterSaga() {
  const max = 1
  const taskMap: { [key: string]: Task } = {}

  let nextAIPlayerIndex = 0
  while (true) {
    const actionTypes: ActionType[] = ['KILL', 'LOAD_STAGE', 'GAMEOVER']
    const action: Action = yield take(actionTypes)
    if (action.type === 'LOAD_STAGE') {
      for (let i = 0; i < max; i += 1) {
        yield* addAI()
      }
    } else if (action.type === 'KILL' && action.targetTank.side === 'ai') {
      // ai-player的坦克被击毁了
      const task = taskMap[action.targetPlayer.playerName]
      task.cancel()
      delete taskMap[action.targetPlayer.playerName]
      yield* addAI()
    } else if (action.type === 'GAMEOVER') {
      // 游戏结束时, 取消所有的ai-player // todo 这里有bug
      for (const [playerName, task] of Object.entries(taskMap)) {
        task.cancel()
        delete taskMap[playerName]
      }
    }
  }

  function* addAI() {
    const { game: { remainingEnemies } }: State = yield select()
    if (!remainingEnemies.isEmpty()) {
      const playerName = `AI-${nextAIPlayerIndex++}`
      yield put<Action>({
        type: 'CREATE_PLAYER',
        player: PlayerRecord({
          playerName,
          lives: Infinity,
          side: 'ai',
        }),
      })
      const { x, y } = yield select(selectors.availableSpawnPosition)
      yield put<Action>({ type: 'REMOVE_FIRST_REMAINING_ENEMY' })
      const level = remainingEnemies.first()
      const hp = level === 'armor' ? 4 : 1
      const tankId = yield* spawnTank(TankRecord({
        x,
        y,
        side: 'ai',
        level,
        hp,
      }))
      taskMap[playerName] = yield spawn(AIWorkerSaga, playerName, AIWorker)

      yield put<Action.ActivatePlayerAction>({
        type: 'ACTIVATE_PLAYER',
        playerName,
        tankId,
      })
    }
  }
}