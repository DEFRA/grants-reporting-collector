import { config } from '#/config.js'
import { processInputMessage } from '#/messaging/inbound/process-message.js'

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
  const status = await collection.findOne({ _id: 'grant-migration' })

  if (status?.status === 'success') {
    logger.info('Migration already completed successfully. Skipping.')
    return
  }

  if (!config.get('agreementsApi.token')) {
    logger.info('Migration not applicable to this environment. Skipping.')
    await collection.updateOne(
      { _id: 'grant-migration' },
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
      { _id: 'grant-migration' },
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

  const ids = await response.json()
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

function incrementYear(dateString, yearsToAdd) {
  const date = new Date(dateString)
  date.setFullYear(date.getFullYear() + yearsToAdd)
  return date.toISOString().substring(0, 10)
}

export function transformToEvent(agreement, grant, versions) {
  const latestVersion = versions[versions.length - 1]
  const reversedVersions = [...versions].reverse()

  const versionWithPayment = reversedVersions.find((v) => v.payment) || latestVersion
  const versionWithStartDate = reversedVersions.find((v) => v.payment?.agreementStartDate) || versionWithPayment

  const annualTotalPence = versionWithPayment.payment?.annualTotalPence?.$numberInt
    ? Number.parseInt(versionWithPayment.payment.annualTotalPence.$numberInt)
    : 0
  const annualTotalPounds = annualTotalPence / 100

  let options = (latestVersion.actionApplications || []).map((app) => {
    const appliedForYear = Number.parseInt(
      versionWithPayment.application?.parcel
        ?.find((p) => p.parcelId === app.parcelId)
        ?.actions?.find((a) => a.code === app.code)?.durationYears.$numberInt ?? '1'
    )

    const startDate =
      versionWithStartDate.payment?.agreementStartDate ??
      new Date(Number.parseInt(versionWithPayment.createdAt?.$date.$numberLong)).toISOString().substring(0, 10)
    const endDate =
      versionWithStartDate.payment?.agreementEndDate ??
      incrementYear(Number.parseInt(versionWithPayment.createdAt?.$date.$numberLong), appliedForYear)
    return {
      parcelReference: app.parcelId || '',
      parcelSizeUnderAgreement: app.appliedFor?.quantity?.$numberDecimal
        ? Number.parseFloat(app.appliedFor.quantity.$numberDecimal)
        : 0,
      optionCode: app.code,
      optionQuantity: app.appliedFor?.quantity?.$numberDecimal
        ? Number.parseFloat(app.appliedFor.quantity.$numberDecimal)
        : 0,
      optionValue: annualTotalPounds,
      optionYear: appliedForYear,
      optionStartDate: startDate,
      optionEndDate: endDate
    }
  })

  if (options.length === 0 && versionWithPayment.payment) {
    options = options.concat(
      (Object.values(versionWithPayment.payment.parcelItems) || []).map((pi) => {
        const appliedForYear = Number.parseInt(
          versionWithPayment.application?.parcel
            ?.find((p) => p.parcelId === pi.parcelId)
            ?.actions?.find((a) => a.code === pi.code)?.durationYears.$numberInt ?? '1'
        )

        const startDate =
          versionWithStartDate.payment?.agreementStartDate ??
          new Date(Number.parseInt(versionWithPayment.createdAt?.$date.$numberLong)).toISOString().substring(0, 10)
        const endDate =
          versionWithStartDate.payment?.agreementEndDate ??
          incrementYear(Number.parseInt(versionWithPayment.createdAt?.$date.$numberLong), appliedForYear)
        return {
          parcelReference: pi.parcelId || '',
          parcelSizeUnderAgreement: Number.parseFloat(pi.quantity.$numberDecimal),
          optionCode: pi.code,
          optionQuantity: Number.parseFloat(pi.quantity.$numberDecimal),
          optionValue: pi.annualPaymentPence?.$numberInt ? Number.parseInt(pi.annualPaymentPence.$numberInt) / 100 : 0,
          optionYear: appliedForYear,
          optionStartDate: startDate,
          optionEndDate: endDate
        }
      })
    )
  }

  return {
    correlationId: latestVersion.correlationId || `migration-${agreement.agreementNumber}`,
    datetime: agreement.createdAt?.$date?.$numberLong || new Date().toISOString(),
    version: '1.0.0',
    application: 'migration-runner',
    service: 'grants',
    eventData: {
      eventType: 'AGREEMENT_CREATED',
      agreementId: agreement.agreementNumber,
      agreementType: grant.code,
      agreementStatus: latestVersion.status,
      ...(versionWithStartDate?.payment?.agreementStartDate && {
        agreementStartDate: versionWithStartDate?.payment?.agreementStartDate
      }),
      ...(versionWithStartDate?.payment?.agreementEndDate && {
        agreementEndDate: versionWithStartDate?.payment?.agreementEndDate
      }),
      agreementValue:
        (versionWithPayment.payment?.agreementTotalPence?.$numberInt
          ? Number.parseInt(versionWithPayment.payment.agreementTotalPence.$numberInt)
          : 0) / 100,
      sbi: agreement.sbi,
      options
    }
  }
}
