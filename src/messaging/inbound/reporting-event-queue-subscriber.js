import { processInputMessage } from './process-message.js'
import { createLogger } from '#/common/helpers/logging/logger.js'
import { config } from '#/config.js'
import { SqsSubscriber } from '@defra/grants-config-utils/sqs-subscriber'

let inputMessageSubscriber

export async function configureAndStartMessaging() {
  const onMessage = async (message, attributes, sentTimestamp) => {
    createLogger().info(attributes, 'Received incoming message')
    await processInputMessage(message, createLogger(), attributes, sentTimestamp)
  }
  inputMessageSubscriber = new SqsSubscriber({
    queueUrl: config.get('aws.sqs.reportingEventsQueueUrl'),
    logger: createLogger(),
    region: config.get('aws.region'),
    awsEndpointUrl: config.get('aws.endpointUrl'),
    onMessage
  })

  await inputMessageSubscriber.start()
  return onMessage
}

export async function stopMessageSubscriber() {
  if (inputMessageSubscriber) {
    await inputMessageSubscriber.stop()
  }
}
