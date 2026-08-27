import { processInputMessage } from './process-message.js'
import { getLogger } from '#/common/helpers/logging/logger.js'
import { config } from '#/config.js'
import { SqsSubscriber } from '@defra/grants-config-utils/sqs-subscriber'

let inputMessageSubscriber

export async function configureAndStartMessaging(db, metrics) {
  const onMessage = async (message, attributes, sentTimestamp) => {
    getLogger().info(attributes, 'Received incoming message')
    await processInputMessage(db, metrics, message, getLogger(), attributes, sentTimestamp)
  }
  inputMessageSubscriber = new SqsSubscriber({
    queueUrl: config.get('aws.sqs.reportingEventsQueueUrl'),
    logger: getLogger(),
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
