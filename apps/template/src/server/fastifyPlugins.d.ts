// The plugins are registered by createBetterApp in the runtime package; these imports bring in the types they add to
// Fastify (request.file, request.user, config.rateLimit).
import '@fastify/jwt'
import '@fastify/multipart'
import '@fastify/rate-limit'
