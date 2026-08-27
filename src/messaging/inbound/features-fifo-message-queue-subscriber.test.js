import { getLogger } from '#/common/helpers/logging/logger.js'
import { config } from '#/config.js'
import { SqsSubscriber } from '@defra/grants-config-utils/sqs-subscriber'
import { processFeaturesMessage } from '#/messaging/inbound/process-features-message.js'
import {
  configureAndStartFeaturesMessaging,
  stopFeaturesMessageSubscriber
} from '#/messaging/inbound/features-fifo-message-queue-subscriber.js'

vi.mock('#/common/helpers/logging/logger.js')
vi.mock('@defra/grants-config-utils/sqs-subscriber')
vi.mock('./process-features-message.js')

describe('FeaturesMessageRequestQueueSubscriber', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.set('aws.sqs.featuresQueueUrl', 'http://localhost:4576/queue/features-queue')
    config.set('aws.region', 'eu-west-2')
    config.set('aws.endpointUrl', 'http://localhost:4576')
  })

  describe('configureAndStartMessaging', () => {
    it('should configure and start the SQS subscriber', async () => {
      const mockLogger = vi.fn()
      getLogger.mockReturnValueOnce(mockLogger)

      await configureAndStartFeaturesMessaging()

      expect(SqsSubscriber).toHaveBeenCalledTimes(1)
      expect(SqsSubscriber).toHaveBeenCalledWith({
        awsEndpointUrl: 'http://localhost:4576',
        logger: mockLogger,
        region: 'eu-west-2',
        queueUrl: 'http://localhost:4576/queue/features-queue',
        onMessage: expect.any(Function)
      })
      expect(SqsSubscriber.mock.instances[0].start).toHaveBeenCalledTimes(1)
    })

    it('should pass message on via onmessage function', async () => {
      const mockLogger = { info: vi.fn() }
      getLogger.mockReturnValue(mockLogger)
      processFeaturesMessage.mockResolvedValueOnce()

      const onMessage = await configureAndStartFeaturesMessaging()

      await onMessage({ claimRef: 'ABC123', sbi: '123456789' }, {}, '1780599163000')

      expect(mockLogger.info).toHaveBeenCalledTimes(1)
      expect(processFeaturesMessage).toHaveBeenCalledTimes(1)
    })
  })

  describe('stopFeaturesMessageSubscriber', () => {
    it('should stop the SQS subscriber', async () => {
      const mockLogger = vi.fn()
      getLogger.mockReturnValueOnce(mockLogger)

      await configureAndStartFeaturesMessaging()

      await stopFeaturesMessageSubscriber()

      const subscriberInstance = SqsSubscriber.mock.instances[0]

      expect(subscriberInstance.stop).toHaveBeenCalledTimes(1)
    })

    it('should do nothing if the SQS subscriber is not present', async () => {
      const mockLogger = vi.fn()
      getLogger.mockReturnValueOnce(mockLogger)

      await stopFeaturesMessageSubscriber()

      const subscriberInstance = SqsSubscriber.mock.instances[0]

      expect(subscriberInstance).toBeUndefined()
    })
  })
})
