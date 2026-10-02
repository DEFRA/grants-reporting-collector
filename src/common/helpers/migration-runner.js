import { GetObjectCommand } from '@aws-sdk/client-s3'
import { initialiseClient, uploadBlob, getBucketName } from '@defra/grants-config-utils/s3-interactions'
import { config } from '#/config.js'

const MISSING_PARCELS_PATCH = 'missing_parcels_patch_migration'

/**
 * Runs the grant migration process.
 * It fetches two files from an S3 bucket, adds a 'parcels' element to the JSON documents,
 * and reuploads them, replacing the original files.
 * @param db
 * @param metrics
 * @param logger
 * @returns {Promise<void>}
 */
export const runMigration = async (db, metrics, logger) => {
  const collection = db.collection('migration_status')
  const status = await collection.findOne({ _id: MISSING_PARCELS_PATCH })

  if (status?.status === 'success') {
    logger.info('Missing parcels patch already completed successfully. Skipping.')
    return
  }

  const fileName1 = config.get('migration.fileName1')
  const fileName2 = config.get('migration.fileName2')
  const parcels1 = config.get('migration.parcels1')
  const parcels2 = config.get('migration.parcels2')

  if (!fileName1 && !fileName2) {
    logger.info('Missing parcels patch not configured. Skipping.')
    return
  }

  logger.info('Starting patch process...')

  try {
    if (fileName1) {
      await processFile(fileName1, parcels1, logger)
    }
    if (fileName2) {
      await processFile(fileName2, parcels2, logger)
    }

    await collection.updateOne(
      { _id: MISSING_PARCELS_PATCH },
      { $set: { status: 'success', completedAt: new Date() } },
      { upsert: true }
    )
    logger.info('Missing parcels patch completed successfully.')
  } catch (err) {
    logger.error(err, 'Missing parcels patch failed')
    throw err
  }
}

async function processFile(fileName, parcels, logger) {
  const client = initialiseClient()
  const bucket = getBucketName()

  logger.info(`Fetching file ${fileName} from bucket ${bucket}`)
  const getCommand = new GetObjectCommand({
    Bucket: bucket,
    Key: fileName
  })

  const response = await client.send(getCommand)
  const body = await response.Body.transformToString()
  const json = JSON.parse(body)

  json.eventData.parcels = parcels

  logger.info(`Re-uploading file ${fileName} with added parcels`)
  await uploadBlob(logger, fileName, JSON.stringify(json))
}
