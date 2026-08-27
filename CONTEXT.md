# grants-reporting-collector

A grants reporting collector that polls an SQS queue and processes raw JSON events by validating and then storing in S3.

## Language

**Reporting collector**
The service that polls an SQS queue and processes raw JSON events by validating and then storing in S3.
_Avoid_: File collector

**Raw events**
The files used as input, that are validated and stores in S3
_Avoid_: Input files, Input JSON
