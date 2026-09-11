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
            json: async () => ({ agreementNumbers: ['grant-1'] })
          })
        }
        if (url.includes('code=frps-private-beta')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ agreementNumbers: [] })
          })
        }
        if (url.includes('grant-1/versions')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              agreement: {
                agreementNumber: 'AGR1',
                sbi: '123',
                createdAt: { $date: { $numberLong: '1780045783425' } }
              },
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
            json: async () => ({ agreementNumbers: ['grant-1'] })
          })
        }
        if (url.includes('code=frps-private-beta')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ agreementNumbers: [] })
          })
        }
        if (url.includes('grant-1/versions')) {
          const offset = new URL(url).searchParams.get('offset')
          if (offset === '0') {
            return Promise.resolve({
              ok: true,
              json: async () => ({
                agreement: {
                  agreementNumber: 'AGR1',
                  sbi: '123',
                  createdAt: { $date: { $numberLong: '1780045783425' } }
                },
                grant: { code: 'woodland' },
                versions: [{ status: 'v1' }],
                nextOffset: 1
              })
            })
          }
          return Promise.resolve({
            ok: true,
            json: async () => ({
              agreement: {
                agreementNumber: 'AGR1',
                sbi: '123',
                createdAt: { $date: { $numberLong: '1780045783425' } }
              },
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
        json: async () => ({ agreementNumbers: ['grant-1'] })
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
            json: async () => ({ agreementNumbers: ['grant-1'] })
          })
        }
        if (url.includes('code=frps-private-beta')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ agreementNumbers: [] })
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
    it('should transform Woodland data correctly', () => {
      const agreement = {
        agreementNumber: 'AGR1',
        sbi: '123',
        createdAt: { $date: { $numberLong: '1780045783425' } }
      }
      const grant = { code: 'woodland' }
      const latestVersion = {
        status: 'active',
        createdAt: { $date: { $numberLong: '1780045783425' } },
        actionApplications: [{ parcelId: 'P1', code: 'PA3', appliedFor: { quantity: { $numberDecimal: '10.5' } } }],
        payment: {
          agreementStartDate: '2026-06-01',
          agreementEndDate: '2029-05-31',
          agreementLevelItems: {
            1: {
              code: 'PA3',
              annualPaymentPence: { $numberInt: '150000' }
            }
          },
          agreementTotalPence: { $numberInt: '150000' }
        }
      }

      const event = transformToEvent(agreement, grant, [latestVersion])
      expect(event.application).toBe('migration-runner')
      expect(event.service).toBe('grants')
      expect(event.eventData.agreementId).toBe('AGR1')
      expect(event.eventData.agreementType).toBe('woodland')
      expect(event.eventData.sbi).toBe('123')
      expect(event.eventData.agreementValue).toBe(1500)
      expect(event.eventData.options).toHaveLength(1)
      expect(event.eventData.options[0].parcelReference).toBe('')
      expect(event.eventData.options[0].optionCode).toBe('PA3')
      expect(event.eventData.options[0].optionQuantity).toBe(10.5)
      expect(event.eventData.options[0].optionValue).toBe(1500)
      expect(event.eventData.options[0].optionStartDate).toBe('2026-06-01')
      expect(event.eventData.options[0].optionEndDate).toBe('2029-05-31')
    })

    it('should search backwards for missing Woodland payment or dates', () => {
      const agreement = {
        agreementNumber: 'AGR1',
        sbi: '123',
        createdAt: { $date: { $numberLong: '1780045783425' } }
      }
      const grant = { code: 'woodland' }
      const versions = [
        {
          createdAt: { $date: { $numberLong: '1780045783425' } },
          payment: {
            agreementStartDate: '2023-01-01',
            agreementEndDate: '2024-01-01',
            agreementLevelItems: {
              1: {
                code: 'PA3',
                annualPaymentPence: { $numberInt: '150000' }
              }
            },
            agreementTotalPence: { $numberInt: '150000' }
          }
        },
        {
          status: 'active',
          correlationId: 'corr-1',
          createdAt: { $date: { $numberLong: '1780045783425' } },
          actionApplications: [{ parcelId: 'P1', code: 'PA3', appliedFor: { quantity: { $numberDecimal: '10.5' } } }]
        }
      ]

      const event = transformToEvent(agreement, grant, versions)
      expect(event.eventData.agreementStatus).toBe('active')
      expect(event.eventData.agreementStartDate).toBe('2023-01-01')
      expect(event.eventData.agreementEndDate).toBe('2024-01-01')
      expect(event.eventData.agreementValue).toBe(1500)
      expect(event.eventData.options[0].optionValue).toBe(1500)
      expect(event.correlationId).toBe('corr-1')
    })

    it('should include options with null dates for Woodland offered agreements with no dates', () => {
      const agreement = { agreementNumber: 'AGR1', createdAt: { $date: { $numberLong: '1780045783425' } } }
      const grant = { code: 'woodland' }
      const latestVersion = {
        status: 'offered',
        payment: {
          agreementLevelItems: { 1: { code: 'PA3' } }
        }
      }
      const event = transformToEvent(agreement, grant, [latestVersion])
      expect(event.eventData.options).toHaveLength(1)
      expect(event.eventData.options[0]).toMatchObject({
        optionCode: 'PA3',
        optionStartDate: null,
        optionEndDate: null
      })
    })

    it('should transform FPTT data correctly', () => {
      const agreement = {
        agreementNumber: 'FPTT1',
        sbi: '456',
        createdAt: { $date: { $numberLong: '1781614946244' } }
      }
      const grant = { code: 'frps-private-beta' }
      const latestVersion = {
        status: 'accepted',
        application: {
          parcel: [
            { parcelId: '1059', sheetId: 'SD7858', actions: [{ code: 'CMOR1', durationYears: { $numberInt: '3' } }] }
          ]
        },
        payment: {
          agreementStartDate: '2026-07-01',
          agreementEndDate: '2027-06-30',
          parcelItems: {
            1: {
              code: 'CMOR1',
              sheetId: 'SD7858',
              parcelId: '1059',
              quantity: { $numberDecimal: '1.4236' },
              annualPaymentPence: { $numberInt: '1509' }
            }
          },
          agreementLevelItems: {
            1: {
              code: 'AGR_FEE',
              annualPaymentPence: { $numberInt: '27200' }
            }
          },
          agreementTotalPence: { $numberInt: '28709' }
        }
      }

      const event = transformToEvent(agreement, grant, [latestVersion])
      expect(event.eventData.agreementType).toBe('frps-private-beta')
      expect(event.eventData.options).toHaveLength(2)

      const parcelOption = event.eventData.options.find((o) => o.parcelReference === 'SD7858-1059')
      expect(parcelOption.optionCode).toBe('CMOR1')
      expect(parcelOption.optionQuantity).toBe(1.4236)
      expect(parcelOption.optionValue).toBe(15.09)
      expect(parcelOption.optionYear).toBe(3)
      expect(parcelOption.optionStartDate).toBe('2026-07-01')

      const agreementOption = event.eventData.options.find((o) => o.parcelReference === '')
      expect(agreementOption.optionCode).toBe('AGR_FEE')
      expect(agreementOption.optionValue).toBe(272)
    })
    it('should emit empty options for FPTT offered agreements with no dates', () => {
      const agreement = { agreementNumber: 'FPTT1', createdAt: { $date: { $numberLong: '1781614946244' } } }
      const grant = { code: 'frps-private-beta' }
      const latestVersion = {
        status: 'offered',
        payment: {
          parcelItems: { 1: { code: 'CMOR1' } },
          agreementLevelItems: { 1: { code: 'AGR_FEE' } }
        }
      }
      const event = transformToEvent(agreement, grant, [latestVersion])
      expect(event.eventData.options).toEqual([])
    })
    it('should throw error for unsupported grant code', () => {
      const agreement = { agreementNumber: 'AGR1' }
      const grant = { code: 'unknown' }
      expect(() => transformToEvent(agreement, grant, [{}])).toThrow('Unsupported grant code: unknown')
    })
  })
})
