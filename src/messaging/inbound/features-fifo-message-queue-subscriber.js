import { createLogger } from '#/common/helpers/logging/logger.js'
import { config } from '#/config.js'
import { processFeaturesMessage } from './process-features-message.js'
import { SqsSubscriber } from '@defra/grants-config-utils/sqs-subscriber'

let inputMessageSubscriber

export async function configureAndStartFeaturesMessaging() {
  const onMessage = async (message, attributes, sentTimestamp) => {
    createLogger().info(attributes, 'Received incoming feature control message')
    await processFeaturesMessage(message, createLogger(), attributes, sentTimestamp)
  }
  inputMessageSubscriber = new SqsSubscriber({
    queueUrl: config.get('aws.sqs.featuresQueueUrl'),
    logger: createLogger(),
    region: config.get('aws.region'),
    awsEndpointUrl: config.get('aws.endpointUrl'),
    onMessage
  })

  await inputMessageSubscriber.start()
  return onMessage
}

export async function stopFeaturesMessageSubscriber() {
  if (inputMessageSubscriber) {
    await inputMessageSubscriber.stop()
  }
}
