import { configureAndStartMessaging, stopMessageSubscriber } from './reporting-event-queue-subscriber.js'
import { createLogger } from '#/common/helpers/logging/logger.js'
import { processInputMessage } from './process-message.js'
import { config } from '#/config.js'
import { SqsSubscriber } from '@defra/grants-config-utils/sqs-subscriber'

vi.mock('../../common/helpers/logging/logger.js')
vi.mock('@defra/grants-config-utils/sqs-subscriber')
vi.mock('./process-message.js')

describe('MessageRequestQueueSubscriber', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.set('aws.sqs.reportingEventsQueueUrl', 'http://localhost:4576/queue/config-input-queue')
    config.set('aws.region', 'eu-west-2')
    config.set('aws.endpointUrl', 'http://localhost:4576')
  })

  describe('configureAndStartMessaging', () => {
    it('should configure and start the SQS subscriber', async () => {
      const mockLogger = vi.fn()
      createLogger.mockReturnValueOnce(mockLogger)

      await configureAndStartMessaging()

      expect(SqsSubscriber).toHaveBeenCalledTimes(1)
      expect(SqsSubscriber).toHaveBeenCalledWith({
        awsEndpointUrl: 'http://localhost:4576',
        logger: mockLogger,
        region: 'eu-west-2',
        queueUrl: 'http://localhost:4576/queue/config-input-queue',
        onMessage: expect.any(Function)
      })
      expect(SqsSubscriber.mock.instances[0].start).toHaveBeenCalledTimes(1)
    })

    it('should pass message on via onmessage function', async () => {
      const mockLogger = { info: vi.fn() }
      createLogger.mockReturnValue(mockLogger)
      processInputMessage.mockResolvedValueOnce()

      const onMessage = await configureAndStartMessaging()

      await onMessage({ claimRef: 'ABC123', sbi: '123456789' }, {}, '1780599163000')

      expect(mockLogger.info).toHaveBeenCalledTimes(1)
      expect(processInputMessage).toHaveBeenCalledTimes(1)
    })
  })

  describe('stopMessageSubscriber', () => {
    it('should stop the SQS subscriber', async () => {
      const mockLogger = vi.fn()
      createLogger.mockReturnValueOnce(mockLogger)

      await configureAndStartMessaging()

      await stopMessageSubscriber()

      const subscriberInstance = SqsSubscriber.mock.instances[0]

      expect(subscriberInstance.stop).toHaveBeenCalledTimes(1)
    })

    it('should do nothing if the SQS subscriber is not present', async () => {
      const mockLogger = vi.fn()
      createLogger.mockReturnValueOnce(mockLogger)

      await stopMessageSubscriber()

      const subscriberInstance = SqsSubscriber.mock.instances[0]

      expect(subscriberInstance).toBeUndefined()
    })
  })
})
