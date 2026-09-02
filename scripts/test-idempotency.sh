#!/bin/bash

# Configuration
if [ -f "compose/aws.env" ]; then
    echo "Loading AWS configuration from compose/aws.env..."
    # Export variables from the env file, ignoring comments
    export $(grep -v '^#' compose/aws.env | xargs)
fi

# Override endpoint for host-to-container communication
ENDPOINT_URL="http://localhost:4566"

SQS_URL="$ENDPOINT_URL/000000000000/gfr__sqs__grants_reporting_events"
S3_BUCKET="raw-event-bucket"
MONGO_CONTAINER="grants-reporting-collector-mongodb-1"
APP_CONTAINER="grants-reporting-collector-grants-reporting-collector-1"
REGION="${AWS_REGION:-eu-west-2}"

MESSAGE_ID="test-msg-$(date +%s)"
AGREEMENT_ID="test-agreement-123"

echo "=== Starting Idempotency Test ==="
echo "Message ID: $MESSAGE_ID"

# 1. Environment Setup: Clear MongoDB
echo "Clearing MongoDB processed_messages collection..."
docker exec -i $MONGO_CONTAINER mongosh grants-reporting-collector --eval 'db.processed_messages.deleteMany({})'

# 2. First Message Injection (Success Path)
echo "Sending first message..."
MESSAGE_BODY='{
  "user": "test-user",
  "sessionId": "session-123",
  "correlationId": "corr-123",
  "datetime": "2023-01-01T00:00:00Z",
  "version": "1.0.0",
  "application": "test-app",
  "service": "test-service",
  "eventData": {
    "accounts": {
      "sbi": "12345"
    },
    "status": "agreed",
    "details": {
      "grantId": "grant-123"
    }
  }
}'
aws --endpoint-url=$ENDPOINT_URL sqs send-message \
    --queue-url $SQS_URL \
    --message-body "$MESSAGE_BODY" \
    --message-attributes "messageId={DataType=String,StringValue=$MESSAGE_ID},agreementId={DataType=String,StringValue=$AGREEMENT_ID}" \
    --region $REGION

echo "Waiting for processing..."
sleep 2

# Verify S3
echo "Checking S3 bucket..."
S3_FILES=$(aws --endpoint-url=$ENDPOINT_URL s3 ls s3://$S3_BUCKET/reporting-events/ --recursive)
echo "S3 Files found:"
echo "$S3_FILES"

if [[ -z "$S3_FILES" ]]; then
    echo "FAILED: No files found in S3 after first message."
    exit 1
fi

# Verify Logs
echo "Checking application logs for first message..."
docker logs $APP_CONTAINER 2>&1 | grep "Received New Reporting event" | grep "$MESSAGE_ID"
if [ $? -ne 0 ]; then
    echo "FAILED: 'Received New Reporting event' not found in logs for $MESSAGE_ID."
    # docker logs $APP_CONTAINER | tail -n 20
    exit 1
fi
echo "SUCCESS: First message processed correctly."

# 3. Second Message Injection (Duplicate Path)
echo "Sending duplicate message..."
aws --endpoint-url=$ENDPOINT_URL sqs send-message \
    --queue-url $SQS_URL \
    --message-body "$MESSAGE_BODY" \
    --message-attributes "messageId={DataType=String,StringValue=$MESSAGE_ID},agreementId={DataType=String,StringValue=$AGREEMENT_ID}" \
    --region $REGION

echo "Waiting for processing..."
sleep 2

# Verify S3 (Count should not have increased)
echo "Checking S3 bucket for duplicates..."
S3_FILES_AFTER=$(aws --endpoint-url=$ENDPOINT_URL s3 ls s3://$S3_BUCKET/reporting-events/ --recursive)
COUNT_BEFORE=$(echo "$S3_FILES" | grep -c ".json")
COUNT_AFTER=$(echo "$S3_FILES_AFTER" | grep -c ".json")

echo "File count before: $COUNT_BEFORE, after: $COUNT_AFTER"
if [ "$COUNT_AFTER" -ne "$COUNT_BEFORE" ]; then
    echo "FAILED: S3 file count increased after duplicate message."
    exit 1
fi

# Verify Logs for duplicate warning
echo "Checking application logs for duplicate warning..."
docker logs $APP_CONTAINER 2>&1 | grep "Receipt of a duplicate message: $MESSAGE_ID"
if [ $? -ne 0 ]; then
    echo "FAILED: 'Receipt of a duplicate message' not found in logs."
    exit 1
fi

echo "Checking for duplicate-message event tracking..."
# Use grep -A to capture multiple lines as pino-pretty splits the event object
docker logs $APP_CONTAINER 2>&1 | grep -A 10 "duplicate-message" | grep "$MESSAGE_ID"
if [ $? -ne 0 ]; then
    echo "FAILED: Event tracking for 'duplicate-message' not found in logs."
    exit 1
fi

echo "=== SUCCESS: Idempotency test passed! ==="
