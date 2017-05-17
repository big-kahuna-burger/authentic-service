var fs = require('fs')
var http = require('http')
var tape = require('tape')
var servertest = require('servertest')
var jwt = require('jsonwebtoken')
var ms = require('ms')
var join = require('path').join

var publicKey = fs.readFileSync(join(__dirname, 'rsa-public.pem'), 'utf-8')
var privateKey = fs.readFileSync(join(__dirname, 'rsa-private.pem'), 'utf-8')

var Authentic = require('../')

var server = null
var auth = null

tape('init', function (t) {
  server = http.createServer(function (req, res) {
    if (req.url !== '/auth/public-key') return
    res.end(JSON.stringify({
      'success': true,
      'data': { 'publicKey': publicKey }
    }))
  })

  server.listen(0, function (err) {
    if (err) return console.error(err)
    auth = Authentic({
      server: 'http://localhost:' + this.address().port
    })
    t.end()
  })
})

tape('should handle anonymous request', function (t) {
  var opts = { method: 'GET' }
  servertest(createService(auth), '/', opts, function (err, res) {
    t.ifError(err, 'should not error')

    var data = JSON.parse(res.body)
    t.equal(data, null, 'should not have authData')
    t.end()
  })
})

tape('should handle bad jwt', function (t) {
  var opts = {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + 'not a jwt'
    }
  }
  servertest(createService(auth), '/', opts, function (err, res) {
    t.ifErr(err, 'should not error on bad token')

    var parsed = JSON.parse(res.body.toString())
    t.deepEqual(parsed, {
      message: 'jwt malformed',
      name: 'JsonWebTokenError',
      statusCode: 401
    }, 'should have correct error')
    t.end()
  })
})

tape('should handle missing token error', function (t) {
  var opts = {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + ''
    }
  }
  servertest(createService(auth), '/', opts, function (err, res) {
    t.ifErr(err, 'should not error on bad token')

    var parsed = JSON.parse(res.body.toString())
    t.deepEqual(parsed, {
      message: 'jwt must be provided',
      name: 'JsonWebTokenError',
      statusCode: 401
    }, 'should have correct error')
    t.end()
  })
})

tape('should handle \'TokenExpiredError\'', function (t) {
  var payload = { email: 'chet@scalehaus.io' }
  var soonToExpireToken = jwt.sign(payload, privateKey, { algorithm: 'RS256', expiresIn: '1' })
  var opts = {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + soonToExpireToken
    }
  }
  var serviceInstance = createService(auth)
  setTimeout(function test () {
    servertest(serviceInstance, '/', opts, function (err, res) {
      t.ifErr(err, 'should not error on expired jwt')

      var parsed = JSON.parse(res.body.toString())
      t.equal(parsed.statusCode, 401, 'status code matches')
      t.equal(parsed.message, 'jwt expired', 'should have correct message')
      t.equal(parsed.name, 'TokenExpiredError', 'should have correct name')
      t.end()
    })
  }, 5) // token expired ~= 4ms ago
})

tape('should handle \'NotBeforeError\'', function (t) {
  var nbf = new Date().getTime() + 10000
  var payload = { email: 'chet@scalehaus.io', nbf }
  var soonToExpireToken = jwt.sign(payload, privateKey, { algorithm: 'RS256' })
  var opts = {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + soonToExpireToken
    }
  }
  var serviceInstance = createService(auth)
  setTimeout(function test () {
    servertest(serviceInstance, '/', opts, function (err, res) {
      t.ifErr(err, 'should not error on expired jwt')

      var parsed = JSON.parse(res.body.toString())
      t.equal(parsed.statusCode, 401, 'status code matches')
      t.equal(parsed.message, 'jwt not active', 'should have correct message')
      t.equal(parsed.name, 'NotBeforeError', 'should have correct name')
      t.end()
    })
  }, 5)
})

tape('should handle auth token', function (t) {
  var now = new Date().getTime()
  var month = '30 days'
  var expiresInMs = now + ms(month)
  var payload = { email: 'chet@scalehaus.io' }
  // https://github.com/auth0/node-jsonwebtoken#token-expiration-exp-claim
  var token = jwt.sign(payload, privateKey, { algorithm: 'RS256', expiresIn: month })

  var opts = {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + token
    }
  }

  servertest(createService(auth), '/', opts, function (err, res) {
    t.ifError(err, 'should not error')
    var data = JSON.parse(res.body)

    t.equal(data.email, 'chet@scalehaus.io', 'should have correct email')
    t.equal(data.exp, ~~(expiresInMs / 1000), 'should have correct exp claim')
    t.equal(data.iat, ~~(now / 1000), 'should have correct iat')

    t.end()
  })
})

tape('cleanup', function (t) {
  server.close()
  t.end()
})

function createService (auth) {
  return http.createServer(function (req, res) {
    auth(req, res, function (err, authData) {
      if (err) {
        err.stack = undefined
        res.writeHead(err.statusCode, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(err))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(authData || null))
    })
  })
}
