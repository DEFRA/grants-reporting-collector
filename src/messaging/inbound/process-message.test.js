import { processInputMessage } from './process-message.js'
import { uploadBlob } from '@defra/grants-config-utils/s3-interactions'

vi.mock('@defra/grants-config-utils/s3-interactions')

describe('Process Message test', () => {
  const mockLogger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }

  beforeEach(async () => {
    vi.clearAllMocks()
  })

  it('should log info and call uploadBlob with correct parameters', async () => {
    uploadBlob.mockResolvedValueOnce(undefined)
    await processInputMessage(
      {
        grant: 'some-grant',
        version: '1.0.0',
        event: 'created',
        status: 'agreed'
      },
      mockLogger,
      [],
      '2023-01-01T00:00:00Z'
    )

    expect(mockLogger.info).toHaveBeenCalledWith('Received New Reporting event: []')
    expect(uploadBlob).toHaveBeenCalledWith(
      mockLogger,
      'reporting-events/2023-01-01T00:00:00Z.json',
      '{"grant":"some-grant","version":"1.0.0","event":"created","status":"agreed"}'
    )
  })

  it('should catch and log error if thrown', async () => {
    uploadBlob.mockThrowOnce(new Error('not successful'))
    await processInputMessage(
      {
        grant: 'some-grant',
        version: '1.0.0'
      },
      mockLogger,
      ['file1.txt']
    )

    expect(mockLogger.error).toHaveBeenCalledWith(new Error('not successful'), 'Unable to process Reporting event:')
  })
})
