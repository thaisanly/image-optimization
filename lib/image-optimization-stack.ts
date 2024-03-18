// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps
} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {getOriginShieldRegion} from './origin-shield';
import {createHash} from 'crypto';

// Stack Parameters
let ENV = 'staging'

// Related to architecture.
// If set to false, transformed images are not stored in S3, and all images request land on Lambda
let STORE_TRANSFORMED_IMAGES = 'true';

// Parameters of S3 bucket where original images are stored
let S3_IMAGE_BUCKET_NAME: string;

// CloudFront parameters
let CLOUDFRONT_ORIGIN_SHIELD_REGION = getOriginShieldRegion(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'ap-southeast-1');
let CLOUDFRONT_CORS_ENABLED = 'true';

// Parameters of transformed images
let S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = '90';
let S3_TRANSFORMED_IMAGE_CACHE_TTL = 'max-age=31622400';

// Max image size in bytes. If generated images are stored on S3, bigger images are generated, stored on S3,
// and request is redirected to the generated image. Otherwise, an application error is sent.
let MAX_IMAGE_SIZE = '4700000';

// Lambda Parameters
let LAMBDA_MEMORY = '1500';
let LAMBDA_TIMEOUT = '60';

type ImageDeliveryCacheBehaviorConfig = {
  origin: any;
  viewerProtocolPolicy: any;
  cachePolicy: any;
  functionAssociations: any;
  responseHeadersPolicy?: any;
};

type LambdaEnv = {
  originalImageBucketName: string,
  transformedImageBucketName?: any;
  transformedImageCacheTTL: string,
  secretKey: string,
  maxImageSize: string,
}

export class ImageOptimizationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Change stack parameters based on provided context
    ENV = this.node.tryGetContext('ENV') || ENV;
    STORE_TRANSFORMED_IMAGES = this.node.tryGetContext('STORE_TRANSFORMED_IMAGES') || STORE_TRANSFORMED_IMAGES;
    S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION') || S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION;
    S3_TRANSFORMED_IMAGE_CACHE_TTL = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_CACHE_TTL') || S3_TRANSFORMED_IMAGE_CACHE_TTL;
    S3_IMAGE_BUCKET_NAME = this.node.tryGetContext('S3_IMAGE_BUCKET_NAME') || S3_IMAGE_BUCKET_NAME;
    CLOUDFRONT_ORIGIN_SHIELD_REGION = this.node.tryGetContext('CLOUDFRONT_ORIGIN_SHIELD_REGION') || CLOUDFRONT_ORIGIN_SHIELD_REGION;
    CLOUDFRONT_CORS_ENABLED = this.node.tryGetContext('CLOUDFRONT_CORS_ENABLED') || CLOUDFRONT_CORS_ENABLED;
    LAMBDA_MEMORY = this.node.tryGetContext('LAMBDA_MEMORY') || LAMBDA_MEMORY;
    LAMBDA_TIMEOUT = this.node.tryGetContext('LAMBDA_TIMEOUT') || LAMBDA_TIMEOUT;
    MAX_IMAGE_SIZE = this.node.tryGetContext('MAX_IMAGE_SIZE') || MAX_IMAGE_SIZE;

    // Create secret key to be used between CloudFront and Lambda URL for access control
    const SECRET_KEY = createHash('md5').update(this.node.addr).digest('hex');

    // For the bucket having original images, either use an external one, or create one with some samples photos.
    let originalImageBucket = s3.Bucket.fromBucketName(this, 'imported-original-image-bucket-' + ENV.toLowerCase(), S3_IMAGE_BUCKET_NAME);

    new CfnOutput(this, 'OriginalImagesS3Bucket-' + ENV.toLowerCase(), {
      description: 'S3 bucket where original images are stored',
      value: originalImageBucket.bucketName
    });

    // create bucket for transformed images if enabled in the architecture
    let transformedImageBucket = new s3.Bucket(this, 's3-transformed-image-bucket-' + ENV.toLowerCase(), {
        bucketName: originalImageBucket.bucketName + "-optimization-" + ENV.toLowerCase(),
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        lifecycleRules: [
          {
            expiration: Duration.days(parseInt(S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION)),
          },
        ],
      });

    // prepare env variable for Lambda 
    const lambdaEnv: LambdaEnv = {
      transformedImageBucketName: transformedImageBucket.bucketName,
      originalImageBucketName: originalImageBucket.bucketName,
      transformedImageCacheTTL: S3_TRANSFORMED_IMAGE_CACHE_TTL,
      secretKey: SECRET_KEY,
      maxImageSize: MAX_IMAGE_SIZE,
    };

    // IAM policy to read from the S3 bucket containing the original images
    const s3ReadOriginalImagesPolicy = new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::' + originalImageBucket.bucketName + '/*'],
    });

    // statements of the IAM policy to attach to Lambda
    const iamPolicyStatements = [s3ReadOriginalImagesPolicy];

    // Create Lambda for image processing
    const lambdaProps = {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-processing'),
      timeout: Duration.seconds(parseInt(LAMBDA_TIMEOUT)),
      memorySize: parseInt(LAMBDA_MEMORY),
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_DAY,
    };

    const imageProcessing = new lambda.Function(this, 'image-optimization-' + ENV.toLowerCase(), lambdaProps);

    // Enable Lambda URL
    const imageProcessingURL = imageProcessing.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // Leverage CDK Intrinsics to get the hostname of the Lambda URL 
    const imageProcessingDomainName = Fn.parseDomainName(imageProcessingURL.url);

    // Create a CloudFront origin: S3 with fallback to Lambda when image needs to be transformed, otherwise with Lambda as sole origin
    let imageOrigin = new origins.OriginGroup({
      primaryOrigin: new origins.S3Origin(transformedImageBucket, {
        originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
      }),
      fallbackOrigin: new origins.HttpOrigin(imageProcessingDomainName, {
        originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
        customHeaders: {
          'x-origin-secret-header': SECRET_KEY,
        },
      }),
      fallbackStatusCodes: [403, 500, 503, 504],
    });

    // write policy for Lambda on the s3 bucket for transformed images
    const s3WriteTransformedImagesPolicy = new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: ['arn:aws:s3:::' + transformedImageBucket.bucketName + '/*'],
    });

    iamPolicyStatements.push(s3WriteTransformedImagesPolicy);

    // attach iam policy to the role assumed by Lambda
    imageProcessing.role?.attachInlinePolicy(
      new iam.Policy(this, 'read-write-bucket-policy', {
        statements: iamPolicyStatements,
      }),
    );

    // Create a CloudFront Function for url rewrites
    const urlRewriteFunction = new cloudfront.Function(this, 'url-rewrite-' + ENV.toLowerCase(), {
      code: cloudfront.FunctionCode.fromFile({ filePath: 'functions/url-rewrite/index.js', }),
      functionName: 'ImageOptimizeUrlRewrite-' + ENV.toLowerCase(),
    });

    const imageDeliveryCacheBehaviorConfig: ImageDeliveryCacheBehaviorConfig = {
      origin: imageOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: new cloudfront.CachePolicy(this, `ImageCachePolicy-` + ENV.toLowerCase(), {
        defaultTtl: Duration.hours(24),
        maxTtl: Duration.days(365),
        minTtl: Duration.seconds(0),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.all()
      }),
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: urlRewriteFunction,
      }],
    };

    if (CLOUDFRONT_CORS_ENABLED === 'true') {

      // Creating a custom response headers policy. CORS allowed for all origins.
      imageDeliveryCacheBehaviorConfig.responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, `ResponseHeadersPolicy-` + ENV.toLowerCase(), {
        responseHeadersPolicyName: 'ImageResponsePolicy-' + ENV.toLowerCase(),
        corsBehavior: {
          accessControlAllowCredentials: false,
          accessControlAllowHeaders: ['*'],
          accessControlAllowMethods: ['GET'],
          accessControlAllowOrigins: ['*'],
          accessControlMaxAge: Duration.seconds(600),
          originOverride: false,
        },

        // recognizing image requests processed by this solution
        customHeadersBehavior: {
          customHeaders: [
            {header: 'x-aws-image-optimization', value: 'v1.0', override: true},
            {header: 'vary', value: 'accept', override: true},
          ],
        }
      });
    }
    const imageDelivery = new cloudfront.Distribution(this, 'ImageDeliveryDistribution-' + ENV.toLowerCase(), {
      comment: 'Image Optimization - ' + ENV.toLowerCase(),
      defaultBehavior: imageDeliveryCacheBehaviorConfig
    });

    new CfnOutput(this, 'ImageDeliveryDomain', {
      description: 'Image Optimization Cloudfront - ' + ENV.toLowerCase(),
      value: imageDelivery.distributionDomainName
    });
  }
}
