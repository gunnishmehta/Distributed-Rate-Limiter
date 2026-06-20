local bucketKey = KEYS[1]
local limit = tonumber(ARGV[1])
local windowSeconds = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local bucketData = redis.call("HGETALL", bucketKey)
local tokens = nil
local lastRefill = nil
for i = 1, #bucketData, 2 do
    if bucketData[i] == "tokens" then
        tokens = tonumber(bucketData[i + 1])
    elseif bucketData[i] == "lastRefill" then
        lastRefill = tonumber(bucketData[i + 1])
    end
end
tokens = tokens or limit
lastRefill = lastRefill or now

local elapsed = (now - lastRefill)/1000
local refillTokens = elapsed * (limit / windowSeconds)
local newTokens = math.min(tokens + refillTokens, limit)

if newTokens >= 1 then
    redis.call("HMSET", bucketKey, "tokens", newTokens - 1, "lastRefill", now)
    return { 1, tostring(newTokens - 1) }
else
    redis.call("HMSET", bucketKey, "tokens", newTokens, "lastRefill", now)
    return { 0, tostring(newTokens) }
end