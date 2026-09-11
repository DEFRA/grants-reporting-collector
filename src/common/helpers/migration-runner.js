import { config } from '#/config.js'
import { processInputMessage } from '#/messaging/inbound/process-message.js'

const MIGRATION_COLLECTION = 'grant-migration'
/**
 * Runs the grant migration process.
 * It checks if the migration has already been completed successfully or if the migration is applicable to the current environment.
 * If applicable, it fetches grant IDs for specified codes and processes each grant by fetching its versions and transforming them
 * into reporting events. We only need this to pick up the historic grants from before reporting launched, it can be deleted after
 * running once in production.
 * @param db
 * @param metrics
 * @param logger
 * @returns {Promise<void>}
 */
export const runMigration = async (db, metrics, logger) => {
  const collection = db.collection('migration_status')
  const status = await collection.findOne({ _id: MIGRATION_COLLECTION })

  if (status?.status === 'success') {
    logger.info('Migration already completed successfully. Skipping.')
    return
  }

  if (!config.get('agreementsApi.token')) {
    logger.info('Migration not applicable to this environment. Skipping.')
    await collection.updateOne(
      { _id: MIGRATION_COLLECTION },
      { $set: { status: 'success', completedAt: new Date() } },
      { upsert: true }
    )
    return
  }

  logger.info('Starting grant migration...')

  try {
    const codes = ['woodland', 'frps-private-beta']
    for (const code of codes) {
      await migrateByCode(code, db, metrics, logger)
    }

    await collection.updateOne(
      { _id: MIGRATION_COLLECTION },
      { $set: { status: 'success', completedAt: new Date() } },
      { upsert: true }
    )
    logger.info('Migration completed successfully.')
  } catch (err) {
    logger.error(err, 'Migration failed')
    throw err
  }
}

async function migrateByCode(code, db, metrics, logger) {
  const { baseUrl, headers } = generateBaseRequest()

  const response = await fetch(`${baseUrl}/internal/migrations/agreements?code=${code}`, { headers })
  if (!response.ok) {
    throw new Error(`Failed to fetch agreements for code ${code}: ${response.statusText}`)
  }

  const { agreementNumbers: ids } = await response.json()
  logger.info(`Found ${ids.length} grants to migrate for code ${code}`)

  for (const grantId of ids) {
    await migrateGrant(grantId, db, metrics, logger)
  }
}

function generateBaseRequest() {
  const baseUrl = config.get('agreementsApi.baseUrl')
  const token = config.get('agreementsApi.token')
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json'
  }
  return { baseUrl, headers }
}

async function migrateGrant(grantId, db, metrics, logger) {
  const { baseUrl, headers } = generateBaseRequest()

  let nextOffset = 0
  let allVersions = []
  let agreementData = null
  let grantData = null

  while (nextOffset !== null) {
    const url = `${baseUrl}/internal/migrations/agreements/${grantId}/versions?offset=${nextOffset}`
    const response = await fetch(url, { headers })
    if (!response.ok) {
      throw new Error(`Failed to fetch versions for grant ${grantId}: ${response.statusText}`)
    }

    const data = await response.json()
    agreementData = data.agreement
    grantData = data.grant
    const versions = data.versions

    if (versions && versions.length > 0) {
      allVersions = allVersions.concat(versions)
    }

    nextOffset = data.nextOffset || null
  }

  if (allVersions.length > 0 && agreementData && grantData) {
    const event = transformToEvent(agreementData, grantData, allVersions)
    const attributes = { messageId: `migration-${grantId}` }
    const sentTimestamp = agreementData.createdAt?.$date?.$numberLong || new Date().toISOString()
    await processInputMessage(db, metrics, event, logger, attributes, sentTimestamp)
  } else {
    logger.warn(`No versions found for grant ${grantId}, skipping.`)
  }
}

export function transformToEvent(agreement, grant, versions) {
  if (grant.code === 'woodland') {
    return transformWoodlandToEvent(agreement, grant, versions)
  }
  if (grant.code === 'frps-private-beta') {
    return transformFpttToEvent(agreement, grant, versions)
  }
  throw new Error(`Unsupported grant code: ${grant.code}`)
}

function transformWoodlandToEvent(agreement, grant, versions) {
  const latestVersion = versions[versions.length - 1]
  const reversedVersions = [...versions].reverse()
  const versionWithPayment = reversedVersions.find((v) => v.payment) || latestVersion
  const versionWithStartDate = reversedVersions.find((v) => v.payment?.agreementStartDate) || versionWithPayment

  const payment = versionWithPayment.payment || {}
  const agreementLevelItems = Object.values(payment.agreementLevelItems || {})

  const options = agreementLevelItems
    .map((item) => {
      const matchingApps = (latestVersion.actionApplications || []).filter((app) => app.code === item.code)
      const aggregateQuantity = matchingApps.reduce((acc, app) => {
        return (
          acc +
          (app.appliedFor?.quantity?.$numberDecimal ? Number.parseFloat(app.appliedFor.quantity.$numberDecimal) : 0)
        )
      }, 0)

      //these dates might not be available, if the agreement hasn't been accepted yet
      const startDate = versionWithStartDate.payment?.agreementStartDate || null
      const endDate = versionWithStartDate.payment?.agreementEndDate || null
      const optionYear =
        startDate && endDate ? new Date(endDate).getFullYear() - new Date(startDate).getFullYear() : null

      return {
        parcelReference: '',
        optionCode: item.code,
        optionQuantity: aggregateQuantity || 1,
        optionValue:
          (item.annualPaymentPence?.$numberInt ? Number.parseInt(item.annualPaymentPence.$numberInt) : 0) / 100,
        optionStartDate: startDate,
        optionEndDate: endDate,
        optionYear
      }
    })
    .filter((o) => o !== null)

  return {
    correlationId: latestVersion.correlationId || `migration-${agreement.agreementNumber}`,
    datetime: new Date(Number.parseInt(agreement.createdAt?.$date?.$numberLong)).toISOString(),
    version: '1.0.0',
    application: 'migration-runner',
    service: 'grants',
    eventData: {
      eventType: 'AGREEMENT_CREATED',
      agreementId: agreement.agreementNumber,
      agreementType: grant.code,
      agreementStatus: latestVersion.status,
      agreementStartDate: versionWithStartDate.payment?.agreementStartDate || null,
      agreementEndDate: versionWithStartDate.payment?.agreementEndDate || null,
      agreementValue:
        (payment.agreementTotalPence?.$numberInt ? Number.parseInt(payment.agreementTotalPence.$numberInt) : 0) / 100,
      sbi: agreement.sbi,
      options
    }
  }
}

function transformFpttToEvent(agreement, grant, versions) {
  const latestVersion = versions[versions.length - 1]
  const reversedVersions = [...versions].reverse()
  const versionWithPayment = reversedVersions.find((v) => v.payment) || latestVersion
  const versionWithStartDate = reversedVersions.find((v) => v.payment?.agreementStartDate) || versionWithPayment

  const payment = versionWithPayment.payment || {}

  const startDate = versionWithStartDate.payment?.agreementStartDate || null
  const endDate = versionWithStartDate.payment?.agreementEndDate || null

  const parcelOptions = Object.values(payment.parcelItems || {})
    .map((pi) => {
      const parcelReference =
        pi.sheetId && pi.parcelId ? `${pi.sheetId}-${pi.parcelId}` : pi.parcelId || pi.sheetId || ''

      const applicationParcel = latestVersion.application?.parcel?.find(
        (p) => p.parcelId === pi.parcelId || p.sheetId === pi.sheetId
      )
      const applicationAction = applicationParcel?.actions?.find((a) => a.code === pi.code)
      const optionYear = applicationAction?.durationYears?.$numberInt
        ? Number.parseInt(applicationAction.durationYears.$numberInt)
        : 1

      if (!startDate || !endDate) {
        return null
      }

      return {
        parcelReference,
        parcelSizeUnderAgreement: pi.quantity?.$numberDecimal ? Number.parseFloat(pi.quantity.$numberDecimal) : 0,
        optionCode: pi.code,
        optionQuantity: pi.quantity?.$numberDecimal ? Number.parseFloat(pi.quantity.$numberDecimal) : 0,
        optionValue: (pi.annualPaymentPence?.$numberInt ? Number.parseInt(pi.annualPaymentPence.$numberInt) : 0) / 100,
        optionYear,
        optionStartDate: startDate,
        optionEndDate: endDate
      }
    })
    .filter((o) => o !== null)

  const agreementOptions = Object.values(payment.agreementLevelItems || {})
    .map((item) => {
      if (!startDate || !endDate) {
        return null
      }

      return {
        parcelReference: '',
        optionCode: item.code,
        optionQuantity: 1,
        optionValue:
          (item.annualPaymentPence?.$numberInt ? Number.parseInt(item.annualPaymentPence.$numberInt) : 0) / 100,
        optionStartDate: startDate,
        optionEndDate: endDate
      }
    })
    .filter((o) => o !== null)

  return {
    correlationId: latestVersion.correlationId || `migration-${agreement.agreementNumber}`,
    datetime: new Date(Number.parseInt(agreement.createdAt?.$date?.$numberLong)).toISOString(),
    version: '1.0.0',
    application: 'migration-runner',
    service: 'grants',
    eventData: {
      eventType: 'AGREEMENT_CREATED',
      agreementId: agreement.agreementNumber,
      agreementType: grant.code,
      agreementStatus: latestVersion.status,
      agreementStartDate: versionWithStartDate.payment?.agreementStartDate || null,
      agreementEndDate: versionWithStartDate.payment?.agreementEndDate || null,
      agreementValue:
        (payment.agreementTotalPence?.$numberInt ? Number.parseInt(payment.agreementTotalPence.$numberInt) : 0) / 100,
      sbi: agreement.sbi,
      options: [...parcelOptions, ...agreementOptions]
    }
  }
}
