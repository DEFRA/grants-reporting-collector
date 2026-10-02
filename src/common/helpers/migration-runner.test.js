import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runMigration } from './migration-runner.js'
import { config } from '#/config.js'
import { initialiseClient, uploadBlob, getBucketName } from '@defra/grants-config-utils/s3-interactions'
import { GetObjectCommand } from '@aws-sdk/client-s3'

vi.mock('#/config.js', () => ({
  config: {
    get: vi.fn()
  }
}))

vi.mock('@defra/grants-config-utils/s3-interactions', () => ({
  initialiseClient: vi.fn(),
  uploadBlob: vi.fn(),
  getBucketName: vi.fn()
}))

vi.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: vi.fn()
}))

describe('migration-runner', () => {
  let mockDb
  let mockMetrics
  let mockLogger
  let mockS3Client

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb = {
      collection: vi.fn().mockReturnThis(),
      findOne: vi.fn(),
      updateOne: vi.fn()
    }
    mockMetrics = {
      counter: vi.fn()
    }
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn()
    }
    mockS3Client = {
      send: vi.fn()
    }
    initialiseClient.mockReturnValue(mockS3Client)
    getBucketName.mockReturnValue('test-bucket')
  })

  describe('runMigration', () => {
    it('should skip if migration already succeeded', async () => {
      mockDb.findOne.mockResolvedValueOnce({ status: 'success' })
      await runMigration(mockDb, mockMetrics, mockLogger)
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Missing parcels patch already completed'))
      expect(initialiseClient).not.toHaveBeenCalled()
    })

    it('should skip if migration not configured', async () => {
      mockDb.findOne.mockResolvedValueOnce(null)
      config.get.mockReturnValue(null)

      await runMigration(mockDb, mockMetrics, mockLogger)
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Missing parcels patch not configured'))
      expect(initialiseClient).not.toHaveBeenCalled()
    })

    it('should fetch, modify and re-upload files', async () => {
      mockDb.findOne.mockResolvedValueOnce(null)
      config.get.mockImplementation((key) => {
        if (key === 'migration.fileName1') return 'file1.json'
        if (key === 'migration.fileName2') return 'file2.json'
        if (key === 'migration.parcels1') return ['parcel1', 'parcel2']
        if (key === 'migration.parcels2') return ['parcel3']
        return null
      })

      const mockBody1 = {
        transformToString: vi.fn().mockResolvedValue(JSON.stringify({ id: '1', name: 'File 1' }))
      }
      const mockBody2 = {
        transformToString: vi.fn().mockResolvedValue(JSON.stringify({ id: '2', name: 'File 2' }))
      }

      mockS3Client.send.mockResolvedValueOnce({ Body: mockBody1 }).mockResolvedValueOnce({ Body: mockBody2 })

      await runMigration(mockDb, mockMetrics, mockLogger)

      expect(initialiseClient).toHaveBeenCalled()
      expect(GetObjectCommand).toHaveBeenCalledTimes(2)
      expect(GetObjectCommand).toHaveBeenNthCalledWith(1, { Bucket: 'test-bucket', Key: 'file1.json' })
      expect(GetObjectCommand).toHaveBeenNthCalledWith(2, { Bucket: 'test-bucket', Key: 'file2.json' })

      expect(uploadBlob).toHaveBeenCalledTimes(2)
      expect(uploadBlob).toHaveBeenNthCalledWith(
        1,
        mockLogger,
        'file1.json',
        JSON.stringify({ id: '1', name: 'File 1', parcels: ['parcel1', 'parcel2'] })
      )
      expect(uploadBlob).toHaveBeenNthCalledWith(
        2,
        mockLogger,
        'file2.json',
        JSON.stringify({ id: '2', name: 'File 2', parcels: ['parcel3'] })
      )

      expect(mockDb.updateOne).toHaveBeenCalledWith(
        { _id: 'missing_parcels_patch_migration' },
        expect.objectContaining({ $set: expect.objectContaining({ status: 'success' }) }),
        { upsert: true }
      )
      expect(mockLogger.info).toHaveBeenCalledWith('Missing parcels patch completed successfully.')
    })

    it('should handle only one file configured', async () => {
      mockDb.findOne.mockResolvedValueOnce(null)
      config.get.mockImplementation((key) => {
        if (key === 'migration.fileName1') return 'file1.json'
        if (key === 'migration.parcels1') return ['parcel1']
        return null
      })

      const mockBody1 = {
        transformToString: vi.fn().mockResolvedValue(JSON.stringify({ id: '1' }))
      }
      mockS3Client.send.mockResolvedValueOnce({ Body: mockBody1 })

      await runMigration(mockDb, mockMetrics, mockLogger)

      expect(GetObjectCommand).toHaveBeenCalledTimes(1)
      expect(uploadBlob).toHaveBeenCalledTimes(1)
      expect(uploadBlob).toHaveBeenCalledWith(
        mockLogger,
        'file1.json',
        JSON.stringify({ id: '1', parcels: ['parcel1'] })
      )
    })

    it('should log error and throw if migration fails', async () => {
      mockDb.findOne.mockResolvedValueOnce(null)
      config.get.mockReturnValue('some-file.json')
      mockS3Client.send.mockRejectedValue(new Error('S3 error'))

      await expect(runMigration(mockDb, mockMetrics, mockLogger)).rejects.toThrow('S3 error')
      expect(mockLogger.error).toHaveBeenCalledWith(expect.any(Error), 'Missing parcels patch failed')
      expect(mockDb.updateOne).not.toHaveBeenCalled()
    })
  })
})
