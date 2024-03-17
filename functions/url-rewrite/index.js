function handler(event) {
    let request = event.request;
    let originalImagePath = request.uri;

    /**
     * Validate, process and normalize the requested operations in query parameters
     */
    let imageOperations = {};

    if (request.querystring) {
        Object.keys(request.querystring).forEach(operation => {
            switch (operation.toLowerCase()) {
                case 'format': 

                    let SUPPORTED_FORMATS = ['auto', 'jpeg', 'webp', 'avif', 'png'];

                    if (request.querystring[operation]['value'] && SUPPORTED_FORMATS.includes(request.querystring[operation]['value'].toLowerCase())) {

                        /**
                         * Normalize to lowercase
                         */
                        let format = request.querystring[operation]['value'].toLowerCase();

                        if (format === 'auto') {
                            format = 'jpeg';
                            if (request.headers['accept']) {
                                if (request.headers['accept'].value.includes("avif")) {
                                    format = 'avif';
                                } else if (request.headers['accept'].value.includes("webp")) {
                                    format = 'webp';
                                } 
                            }
                        }
                        imageOperations['format'] = format;
                    }
                    break;
                case 'width':
                    if (request.querystring[operation]['value']) {
                        let width = parseInt(request.querystring[operation]['value']);
                        if (!isNaN(width) && (width > 0)) {
                            /**
                             * You can protect the Lambda function by setting a max value, e.g. if (width > 4000) width = 4000;
                             */
                            imageOperations['width'] = width.toString();
                        }
                    }
                    break;
                case 'height':
                    if (request.querystring[operation]['value']) {
                        let height = parseInt(request.querystring[operation]['value']);
                        if (!isNaN(height) && (height > 0)) {
                            /**
                             * You can protect the Lambda function by setting a max value, e.g. if (height > 4000) height = 4000;
                             */
                            imageOperations['height'] = height.toString();
                        }
                    }
                    break;
                case 'quality':
                    if (request.querystring[operation]['value']) {
                        let quality = parseInt(request.querystring[operation]['value']);
                        if (!isNaN(quality) && (quality > 0)) {
                            if (quality > 100) quality = 100;
                            imageOperations['quality'] = quality.toString();
                        }
                    }
                    break;
                default: break;
            }
        });

        /**
         * Rewrite the path to normalized version if valid operations are found
         */
        if (Object.keys(imageOperations).length > 0) {

            let queryStrings = [];

            if (imageOperations.format) {
                queryStrings.push('format='+imageOperations.format)
            }

            if (imageOperations.quality) {
                queryStrings.push('quality='+imageOperations.quality)
            }

            if (imageOperations.width) {
                queryStrings.push('width='+imageOperations.width)
            }

            if (imageOperations.height) {
                queryStrings.push('height='+imageOperations.height)
            }

            request.uri = originalImagePath + '/' + queryStrings.join(',');
        } else {

            /**
             * If no valid operation is found, flag the request with /original path suffix
             */
            request.uri = originalImagePath + '/original';
        }

    } else {
        /**
         * If no query strings are found, flag the request with /original path suffix
         */
        request.uri = originalImagePath + '/original'; 
    }

    /**
     * Remove query strings
     */
    request['querystring'] = {};
    return request;
}
