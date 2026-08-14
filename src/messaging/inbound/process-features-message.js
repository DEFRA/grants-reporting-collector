export const processFeaturesMessage = async (_message, logger, attributes, _sentTimestamp) => {
  try {
    const { name, scopes, updatedBy, valueType } = attributes

    logger.info(
      `Received Feature control notification: ${name} (${valueType}), scopes: ${scopes}, updatedBy: ${updatedBy}`
    )
  } catch (err) {
    logger.error(err, 'Unable to process Input request:')
  }
}
