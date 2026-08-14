#!/bin/bash

# S3 buckets
aws --endpoint-url=http://localhost:4566 s3 mb s3://raw-event-bucket

function create_topic() {
  local topic_name=$1

  if [[ "$topic_name" == *.fifo ]]; then
    local topic_arn=$(aws sns create-topic \
      --name "$topic_name" \
      --attributes FifoTopic=true \
      --query "TopicArn" \
      --output text)
  else
    local topic_arn=$(aws sns create-topic \
      --name "$topic_name" \
      --query "TopicArn" \
      --output text)
  fi
  echo $topic_arn
}

function is_fifo() {
  [[ "$1" == *.fifo ]]
}

function create_queue() {
  local queue_name=$1
  local dlq_name

  if is_fifo "$queue_name"; then
    local dlq_name="${queue_name%.fifo}-dead-letter-queue.fifo"
    # Create the DLQ
      local dlq_url=$(
        aws sqs create-queue \
        --queue-name "$dlq_name" \
        --attributes FifoQueue=true \
        --query "QueueUrl" --output text
      )

      local dlq_arn=$(
        aws sqs get-queue-attributes \
          --queue-url $dlq_url \
          --attribute-name "QueueArn" \
          --query "Attributes.QueueArn" \
          --output text
      )

      # Create the queue with DLQ attached
      local queue_url=$(
        aws sqs create-queue \
          --queue-name $queue_name \
          --attributes '{ "FifoQueue": "true", "RedrivePolicy": "{\"deadLetterTargetArn\":\"'$dlq_arn'\",\"maxReceiveCount\":\"1\"}" }' \
          --query "QueueUrl" \
          --output text
      )

      local queue_arn=$(
        aws sqs get-queue-attributes \
          --queue-url $queue_url \
          --attribute-name "QueueArn" \
          --query "Attributes.QueueArn" \
          --output text
      )

      echo $queue_arn
  else
    local dlq_name="${queue_name%.fifo}-dead-letter-queue"
    # Create the DLQ
      local dlq_url=$(
        aws sqs create-queue \
        --queue-name "$dlq_name" \
        --query "QueueUrl" --output text
      )

      local dlq_arn=$(
        aws sqs get-queue-attributes \
          --queue-url $dlq_url \
          --attribute-name "QueueArn" \
          --query "Attributes.QueueArn" \
          --output text
      )

      # Create the queue with DLQ attached
      local queue_url=$(
        aws sqs create-queue \
          --queue-name $queue_name \
          --attributes '{ "RedrivePolicy": "{\"deadLetterTargetArn\":\"'$dlq_arn'\",\"maxReceiveCount\":\"1\"}" }' \
          --query "QueueUrl" \
          --output text
      )

      local queue_arn=$(
        aws sqs get-queue-attributes \
          --queue-url $queue_url \
          --attribute-name "QueueArn" \
          --query "Attributes.QueueArn" \
          --output text
      )

      echo $queue_arn
  fi
}

function subscribe_queue_to_topic() {
  local topic_arn=$1
  local queue_arn=$2

  aws sns subscribe --topic-arn $topic_arn --protocol sqs --notification-endpoint $queue_arn --attributes '{ "RawMessageDelivery": "true" }'
}

function create_topic_and_queue() {
  local topic_name=$1
  local queue_name=$2

  local topic_arn=$(create_topic $topic_name)
  local queue_arn=$(create_queue $queue_name)

  subscribe_queue_to_topic $topic_arn $queue_arn
}

#input for the reporting events
create_topic_and_queue "gfr__sns___reporting_events" "gfr__sqs__grants_reporting_events"
#input for the feature control events
create_topic_and_queue "gfr__sns__feature_control.fifo" "gfr__sqs__rc_feature_control_updates.fifo"
#audit events if we need them....
#create_topic_and_queue "fcp_audit_grants_config_broker" "fake_dal_sqs_fcp_audit"

wait

aws sqs list-queues
aws sns list-topics

echo "SNS/SQS ready"
