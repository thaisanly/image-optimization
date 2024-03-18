function handler(event) {

    const SUPPORTED_FORMATS = ['jpg', 'jpeg', 'webp', 'avif', 'png'];

    const request = event.request;
    const originalImagePath = request.uri;

    const isImageRequest = function (request) {
        const urlParts = request.uri.split('?');
        const filename = urlParts[0].split('/').pop();
        const parts = filename.split('.');

        if (parts.length > 1) {
            const potentialExtension = parts.pop().toLowerCase();
            return SUPPORTED_FORMATS.includes(potentialExtension)
        }

        return false;
    }

    /**
     * validate, process and normalize the requested operations in query parameters
     */
    const normalizedOperations = {};

    if (isImageRequest(request) && request.querystring) {
        Object.keys(request.querystring).forEach(operation => {
            switch (operation.toLowerCase()) {
                case 'format':
                    if (request.querystring[operation]['value'] && SUPPORTED_FORMATS.includes(request.querystring[operation]['value'].toLowerCase())) {
                        /** normalize to lowercase **/
                        let format = request.querystring[operation]['value'].toLowerCase();
                        if (request.headers['accept']) {
                            if (request.headers['accept'].value.includes("avif")) {
                                format = 'avif';
                            } else if (request.headers['accept'].value.includes("webp")) {
                                format = 'webp';
                            }
                        }
                        normalizedOperations['format'] = format;
                    }
                    break;
                case 'width':
                    if (request.querystring[operation]['value']) {
                        const width = parseInt(request.querystring[operation]['value']);
                        if (!isNaN(width) && (width > 0)) {
                            /** you can protect the Lambda function by setting a max value, e.g., if (width > 4000) width = 4000; **/
                            normalizedOperations['width'] = width.toString();
                        }
                    }
                    break;
                case 'height':
                    if (request.querystring[operation]['value']) {
                        const height = parseInt(request.querystring[operation]['value']);
                        if (!isNaN(height) && (height > 0)) {
                            /** you can protect the Lambda function by setting a max value, e.g., if (height > 4000) height = 4000; **/
                            normalizedOperations['height'] = height.toString();
                        }
                    }
                    break;
                case 'quality':
                    if (request.querystring[operation]['value']) {
                        let quality = parseInt(request.querystring[operation]['value']);
                        if (!isNaN(quality) && (quality > 0)) {
                            if (quality > 100) quality = 100;
                            normalizedOperations['quality'] = quality.toString();
                        }
                    }
                    break;
                default: break;
            }
        });

        /**
         * rewrite the path to normalized version if valid operations are found
         */
        if (Object.keys(normalizedOperations).length > 0) {
            /** put them in order **/
            const normalizedOperationsArray = [];
            if (normalizedOperations.format) normalizedOperationsArray.push('format='+normalizedOperations.format);
            if (normalizedOperations.quality) normalizedOperationsArray.push('quality='+normalizedOperations.quality);
            if (normalizedOperations.width) normalizedOperationsArray.push('width='+normalizedOperations.width);
            if (normalizedOperations.height) normalizedOperationsArray.push('height='+normalizedOperations.height);
            request.uri = originalImagePath + '/' + normalizedOperationsArray.join(',');
            request['querystring'] = {};
            return request;
        }
    }

    /** If no query strings are found, flag the request with /original path suffix **/
    request['querystring'] = {};
    request.uri = originalImagePath + '/original';
    return request;
}