"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getClientIdentity = void 0;
exports.streamsRateLimit = streamsRateLimit;
const rate_limit_1 = require("@/app/lib/rate-limit");
Object.defineProperty(exports, "getClientIdentity", { enumerable: true, get: function () { return rate_limit_1.getClientIdentity; } });
const rate_limit_config_1 = require("@/app/lib/rate-limit-config");
const rate_limit_metrics_1 = require("@/app/lib/rate-limit-metrics");
function getRequestUrl(request, fallbackPath) {
    try {
        return request.url ? new URL(request.url) : new URL(`http://localhost${fallbackPath}`);
    }
    catch {
        return new URL(`http://localhost${fallbackPath}`);
    }
}
async function streamsRateLimit(request, method, path) {
    const url = getRequestUrl(request, path);
    const limitType = (0, rate_limit_config_1.getLimitForRoute)(method, url.pathname);
    const identity = (0, rate_limit_1.getClientIdentity)(request);
    const result = await (0, rate_limit_1.checkRateLimit)(identity, limitType);
    if (!result.allowed) {
        (0, rate_limit_metrics_1.recordThrottle)(url.pathname, limitType, identity.type, identity.displayValue);
        return { allowed: false, response: (0, rate_limit_1.rateLimitResponse)(result.retryAfter) };
    }
    (0, rate_limit_metrics_1.recordRequest)(url.pathname);
    return { allowed: true };
}
