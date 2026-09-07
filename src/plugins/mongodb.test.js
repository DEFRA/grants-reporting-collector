import Hapi from '@hapi/hapi'
import { Db, MongoClient } from 'mongodb'
import { LockManager } from 'mongo-locks'
import { config } from '#/config.js'
import { mongoDb } from './mongodb.js'

describe('#mongoDb', () => {
  let server

  describe('Plugin metadata', () => {
    test('should expose correct plugin metadata', () => {
      expect(mongoDb.plugin.name).toBe('mongodb')
      expect(mongoDb.plugin.version).toBe('1.0.0')
    })
  })

  describe('Set up', () => {
    beforeAll(async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { createServer } = await import('#/server.js')

      server = await createServer()
      await server.initialize()
    })

    afterAll(async () => {
      vi.spyOn(server.mongoClient, 'close').mockResolvedValue()
      await server.stop()
    })

    test('Server should have expected MongoDb decorators', () => {
      expect(server.db).toBeInstanceOf(Db)
      expect(server.mongoClient).toBeInstanceOf(MongoClient)
      expect(server.locker).toBeInstanceOf(LockManager)
    })

    test('MongoDb should have expected database name', () => {
      expect(server.db.databaseName).toBe('grants-reporting-collector')
    })

    test('MongoDb should have expected namespace', () => {
      expect(server.db.namespace).toBe('grants-reporting-collector')
    })

    test('Request should have expected MongoDb decorators', async () => {
      server.route({
        method: 'GET',
        path: '/test-mongodb-request-decorators',
        handler: (request) => {
          expect(request.db).toBeInstanceOf(Db)
          expect(request.locker).toBeInstanceOf(LockManager)
          return { ok: true }
        }
      })

      const response = await server.inject({
        method: 'GET',
        url: '/test-mongodb-request-decorators'
      })

      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.payload)).toEqual({ ok: true })
    })
  })

  describe('Shut down', () => {
    beforeAll(async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { createServer } = await import('#/server.js')

      server = await createServer()
      await server.initialize()
    })

    test('Should close Mongo client on server stop', async () => {
      const closeSpy = vi.spyOn(server.mongoClient, 'close').mockResolvedValue()
      await server.stop({ timeout: 1000 })

      expect(closeSpy).toHaveBeenCalled()
    })
  })

  describe('Non-test environment', () => {
    const originalEnv = process.env.NODE_ENV

    afterEach(() => {
      process.env.NODE_ENV = originalEnv
    })

    test('Should register plugin and create real indexes when NODE_ENV is production', async () => {
      process.env.NODE_ENV = 'production'
      const testServer = Hapi.server()
      const loggerMock = { info: vi.fn(), error: vi.fn() }
      testServer.decorate('server', 'logger', loggerMock)

      await testServer.register({
        plugin: mongoDb,
        options: config.get('mongo')
      })

      expect(testServer.db).toBeInstanceOf(Db)
      expect(testServer.mongoClient).toBeInstanceOf(MongoClient)
      expect(testServer.locker).toBeInstanceOf(LockManager)
      expect(loggerMock.info).toHaveBeenCalledWith('Setting up MongoDb')
      expect(loggerMock.info).toHaveBeenCalledWith(`MongoDb connected to ${config.get('mongo').databaseName}`)

      await testServer.stop()
    })
  })

  describe('Error handling', () => {
    test('Should log error when createIndexes fails during registration', async () => {
      const origEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'

      const testServer = Hapi.server()
      const loggerMock = { info: vi.fn(), error: vi.fn() }
      testServer.decorate('server', 'logger', loggerMock)

      const indexError = new Error('Index creation failed')
      const mockDb = {
        collection: vi.fn().mockReturnValue({
          createIndex: vi.fn().mockRejectedValue(indexError),
          createIndexes: vi.fn()
        })
      }
      const mockClient = {
        db: vi.fn().mockReturnValue(mockDb),
        close: vi.fn().mockResolvedValue()
      }

      const connectSpy = vi.spyOn(MongoClient, 'connect').mockResolvedValue(mockClient)

      try {
        await testServer.register({
          plugin: mongoDb,
          options: {
            mongoUrl: 'mongodb://localhost:27017',
            databaseName: 'test-db',
            mongoOptions: {}
          }
        })

        expect(loggerMock.error).toHaveBeenCalledWith(indexError, 'Failed to create indexes')
      } finally {
        process.env.NODE_ENV = origEnv
        connectSpy.mockRestore()
        await testServer.stop()
      }
    })

    test('Should log error when mongoClient.close fails on server stop', async () => {
      const testServer = Hapi.server()
      const loggerMock = { info: vi.fn(), error: vi.fn() }
      testServer.decorate('server', 'logger', loggerMock)

      const closeError = new Error('Client close failed')
      const mockClient = {
        db: vi.fn().mockReturnValue({
          collection: vi.fn().mockReturnValue({
            createIndex: vi.fn().mockResolvedValue(),
            createIndexes: vi.fn().mockResolvedValue()
          })
        }),
        close: vi.fn().mockRejectedValue(closeError)
      }

      const connectSpy = vi.spyOn(MongoClient, 'connect').mockResolvedValue(mockClient)

      try {
        await testServer.register({
          plugin: mongoDb,
          options: {
            mongoUrl: 'mongodb://localhost:27017',
            databaseName: 'test-db',
            mongoOptions: {}
          }
        })

        await testServer.stop()

        expect(loggerMock.error).toHaveBeenCalledWith(closeError, 'failed to close mongo client')
      } finally {
        connectSpy.mockRestore()
      }
    })
  })
})
