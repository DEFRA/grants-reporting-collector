import { config } from '#/config.js'
import { initialiseClient, uploadBlob } from '@defra/grants-config-utils/s3-interactions'
import { MONGODB_DUPLICATE_KEY_ERROR } from '#/common/constants.js'
import { trackEvent } from '#/common/helpers/logging/logger.js'
import { validateReportingEvent } from '@defra/grants-reporting-publisher'

export const processInputMessage = async (db, metrics, message, logger, attributes, sentTimestamp) => {
  await metrics.counter('reporting-message-received')
  const { valid, errors } = validateReportingEvent(message)
  if (!valid) {
    await metrics.counter('reporting-message-received-invalid')
    logger.error(`Invalid Reporting event, cannot process: ${errors}`)
    throw new Error(`Invalid Reporting event, cannot process: ${errors}`)
  }
  const { messageId, agreementId } = attributes
  if (await checkForDuplicate(db, logger, messageId, agreementId)) {
    return
  }

  logger.info(`Received New Reporting event: ${JSON.stringify(attributes)}`)
  await metrics.counter('reporting-message-received-success')

  //for now we are just going to dump straight into S3 bucket, but we will need to think about how we want to name the files and partition them in the bucket
  await uploadBlob(logger, `reporting-events/${sentTimestamp}.json`, JSON.stringify(message))
}

const checkForDuplicate = async (db, logger, messageId, agreementId) => {
  if (messageId) {
    try {
      await db.collection('processed_messages').insertOne({ _id: messageId, processedAt: new Date() })
    } catch (err) {
      if (err.code === MONGODB_DUPLICATE_KEY_ERROR) {
        logger.info(`Receipt of a duplicate message: ${messageId}`)
        trackEvent(logger, 'duplicate-message', 'inbound', {
          reference: `messageId: ${messageId}, agreementId: ${agreementId}`
        })
        return true
      }
      throw err
    }
  }
  return false
}

export const setupS3Client = () => {
  initialiseClient({
    region: config.get('aws.region'),
    endpoint: config.get('aws.endpointUrl'),
    forcePathStyle: config.get('aws.s3.forcePathStyle'),
    bucketNameOverride: config.get('aws.s3.bucketName')
  })
}
