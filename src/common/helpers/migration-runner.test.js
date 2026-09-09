import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runMigration, transformToEvent } from './migration-runner.js'
import { processInputMessage } from '#/messaging/inbound/process-message.js'
import { config } from '#/config.js'

vi.mock('#/config.js', () => ({
  config: {
    get: vi.fn((key) => {
      if (key === 'agreementsApi.baseUrl') return 'https://api.example.com'
      if (key === 'agreementsApi.token') return 'test-token'
      if (key === 'aws.region') return 'eu-west-2'
      return null
    })
  }
}))

vi.mock('#/messaging/inbound/process-message.js', () => ({
  processInputMessage: vi.fn(),
  setupS3Client: vi.fn()
}))

describe('migration-runner', () => {
  let mockDb
  let mockMetrics
  let mockLogger

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
    global.fetch = vi.fn()
  })

  describe('runMigration', () => {
    it('should skip if migration already succeeded', async () => {
      mockDb.findOne.mockResolvedValue({ status: 'success' })
      await runMigration(mockDb, mockMetrics, mockLogger)
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('already completed'))
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('should skip if no api token available', async () => {
      mockDb.findOne.mockResolvedValue(null)
      config.get.mockImplementationOnce(() => null)
      await runMigration(mockDb, mockMetrics, mockLogger)
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Migration not applicable to this environment. Skipping')
      )
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('should run migration and record success', async () => {
      mockDb.findOne.mockResolvedValue(null)

      global.fetch = vi.fn((url) => {
        if (url.includes('code=woodland')) {
          return Promise.resolve({
            ok: true,
            json: async () => ['grant-1']
          })
        }
        if (url.includes('code=frps-private-beta')) {
          return Promise.resolve({
            ok: true,
            json: async () => []
          })
        }
        if (url.includes('grant-1/versions')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              agreement: { agreementNumber: 'AGR1', sbi: '123' },
              grant: { code: 'woodland' },
              versions: [{ status: 'active', actionApplications: [] }],
              nextOffset: null
            })
          })
        }
        return Promise.resolve({ ok: false })
      })

      await runMigration(mockDb, mockMetrics, mockLogger)

      expect(processInputMessage).toHaveBeenCalled()
      expect(mockDb.updateOne).toHaveBeenCalledWith(
        { _id: 'grant-migration' },
        expect.objectContaining({ $set: expect.objectContaining({ status: 'success' }) }),
        { upsert: true }
      )
    })

    it('should handle pagination in versions', async () => {
      mockDb.findOne.mockResolvedValue(null)

      global.fetch = vi.fn((url) => {
        if (url.includes('code=woodland')) {
          return Promise.resolve({
            ok: true,
            json: async () => ['grant-1']
          })
        }
        if (url.includes('code=frps-private-beta')) {
          return Promise.resolve({
            ok: true,
            json: async () => []
          })
        }
        if (url.includes('grant-1/versions')) {
          const offset = new URL(url).searchParams.get('offset')
          if (offset === '0') {
            return Promise.resolve({
              ok: true,
              json: async () => ({
                agreement: { agreementNumber: 'AGR1', sbi: '123' },
                grant: { code: 'woodland' },
                versions: [{ status: 'v1' }],
                nextOffset: 1
              })
            })
          }
          return Promise.resolve({
            ok: true,
            json: async () => ({
              agreement: { agreementNumber: 'AGR1', sbi: '123' },
              grant: { code: 'woodland' },
              versions: [{ status: 'v2' }],
              nextOffset: null
            })
          })
        }
        return Promise.resolve({ ok: false })
      })

      await runMigration(mockDb, mockMetrics, mockLogger)

      expect(processInputMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          eventData: expect.objectContaining({ agreementStatus: 'v2' })
        }),
        expect.anything(),
        expect.anything(),
        expect.anything()
      )
    })

    it('should stop and log error if API fails to fetch agreement IDs', async () => {
      mockDb.findOne.mockResolvedValue(null)
      global.fetch.mockResolvedValueOnce({ ok: false, statusText: 'Bad Request' })

      await expect(runMigration(mockDb, mockMetrics, mockLogger)).rejects.toThrow(
        'Failed to fetch agreements for code woodland'
      )
      expect(mockLogger.error).toHaveBeenCalled()
      expect(mockDb.updateOne).not.toHaveBeenCalled()
    })

    it('should stop and log error if API fails to fetch versions', async () => {
      mockDb.findOne.mockResolvedValue(null)
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ['grant-1']
      })
      global.fetch.mockResolvedValueOnce({ ok: false, statusText: 'Server Error' })

      await expect(runMigration(mockDb, mockMetrics, mockLogger)).rejects.toThrow(
        'Failed to fetch versions for grant grant-1'
      )
      expect(mockLogger.error).toHaveBeenCalled()
    })

    it('should warn if no versions found for a grant', async () => {
      mockDb.findOne.mockResolvedValue(null)

      global.fetch = vi.fn((url) => {
        if (url.includes('code=woodland')) {
          return Promise.resolve({
            ok: true,
            json: async () => ['grant-1']
          })
        }
        if (url.includes('code=frps-private-beta')) {
          return Promise.resolve({
            ok: true,
            json: async () => []
          })
        }
        if (url.includes('grant-1/versions')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              agreement: {},
              grant: {},
              versions: [],
              nextOffset: null
            })
          })
        }
        return Promise.resolve({ ok: false })
      })

      await runMigration(mockDb, mockMetrics, mockLogger)
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('No versions found'))
    })
  })

  describe('transformToEvent', () => {
    it('should transform data correctly', () => {
      const agreement = { agreementNumber: 'AGR1', sbi: '123' }
      const grant = { code: 'woodland' }
      const latestVersion = {
        status: 'active',
        createdAt: { $date: { $numberLong: '1780045783425' } },
        actionApplications: [{ parcelId: 'P1', code: 'C1', appliedFor: { quantity: { $numberDecimal: '10.5' } } }],
        payment: {
          annualTotalPence: { $numberInt: '1000' },
          agreementTotalPence: { $numberInt: '5000' }
        }
      }

      const event = transformToEvent(agreement, grant, [latestVersion])
      expect(event.application).toBe('migration-runner')
      expect(event.service).toBe('grants-reporting-collector')
      expect(event.eventData.agreementId).toBe('AGR1')
      expect(event.eventData.agreementType).toBe('woodland')
      expect(event.eventData.sbi).toBe('123')
      expect(event.eventData.agreementValue).toBe(5000)
      expect(event.eventData.options).toHaveLength(1)
      expect(event.eventData.options[0].parcelReference).toBe('P1')
      expect(event.eventData.options[0].optionCode).toBe('C1')
      expect(event.eventData.options[0].optionQuantity).toBe(10.5)
      expect(event.eventData.options[0].optionValue).toBe(1000)
      expect(event.eventData.options[0].optionStartDate).toBeNull()
    })

    it('should search backwards for missing payment or dates', () => {
      const agreement = { agreementNumber: 'AGR1', sbi: '123' }
      const grant = { code: 'woodland' }
      const versions = [
        {
          payment: {
            agreementStartDate: '2023-01-01',
            agreementEndDate: '2024-01-01',
            annualTotalPence: { $numberInt: '1000' },
            agreementTotalPence: { $numberInt: '5000' }
          }
        },
        {
          status: 'active',
          correlationId: 'corr-1',
          actionApplications: [{ parcelId: 'P1', code: 'C1', appliedFor: { quantity: { $numberDecimal: '10.5' } } }]
        }
      ]

      const event = transformToEvent(agreement, grant, versions)
      expect(event.eventData.agreementStatus).toBe('active')
      expect(event.eventData.agreementStartDate).toBe('2023-01-01')
      expect(event.eventData.agreementEndDate).toBe('2024-01-01')
      expect(event.eventData.agreementValue).toBe(5000)
      expect(event.eventData.options[0].optionValue).toBe(1000)
      expect(event.correlationId).toBe('corr-1')
    })

    it('should handle missing payment or applications', () => {
      const agreement = { agreementNumber: 'AGR1', sbi: '123' }
      const grant = { code: 'woodland' }
      const latestVersion = {
        status: 'pending',
        createdAt: { $date: { $numberLong: '1780045783425' } }
      }

      const event = transformToEvent(agreement, grant, [latestVersion])
      expect(event.eventData.agreementValue).toBe(0)
      expect(event.eventData.options).toEqual([])
    })
  })
})
