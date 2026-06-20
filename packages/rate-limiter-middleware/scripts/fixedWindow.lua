local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowSeconds = tonumber(ARGV[2])

local count = redis.call("INCR", key)
if count == 1 then
    redis.call("EXPIRE", key, windowSeconds)
end

local resetTime = redis.call("TTL", key)

if count > limit then
    return {0, 0, resetTime}
end

return {1, limit-count, resetTime}