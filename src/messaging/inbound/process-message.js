import { config } from '#/config.js'
import { initialiseClient, uploadBlob } from '@defra/grants-config-utils/s3-interactions'

export const processInputMessage = async (message, logger, attributes, sentTimestamp) => {
  try {
    logger.info(`Received New Reporting event: ${JSON.stringify(attributes)}`)

    //for now we are just going to dump straight into S3 bucket, but we will need to add some validation logic here in the future
    //and will also need to think about how we want to name the files and partition them in the bucket
    await uploadBlob(logger, `reporting-events/${sentTimestamp}.json`, JSON.stringify(message))
  } catch (err) {
    logger.error(err, 'Unable to process Reporting event:')
  }
}

export const setupS3Client = () => {
  initialiseClient({
    region: config.get('aws.region'),
    endpoint: config.get('aws.endpointUrl'),
    forcePathStyle: config.get('aws.s3.forcePathStyle'),
    bucketNameOverride: config.get('aws.s3.bucketName')
  })
}
