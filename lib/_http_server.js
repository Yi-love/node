'use strict';

const util = require('util');
const net = require('net');
const HTTPParser = process.binding('http_parser').HTTPParser;
const assert = require('assert').ok;
const common = require('_http_common');
const parsers = common.parsers;
const freeParser = common.freeParser;
const debug = common.debug;
const CRLF = common.CRLF;
const continueExpression = common.continueExpression;
const chunkExpression = common.chunkExpression;
const httpSocketSetup = common.httpSocketSetup;
const OutgoingMessage = require('_http_outgoing').OutgoingMessage;

const STATUS_CODES = exports.STATUS_CODES = {
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',                 // RFC 2518, obsoleted by RFC 4918
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',               // RFC 4918
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',         // RFC 7238
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: 'I\'m a teapot',              // RFC 2324
  421: 'Misdirected Request',
  422: 'Unprocessable Entity',       // RFC 4918
  423: 'Locked',                     // RFC 4918
  424: 'Failed Dependency',          // RFC 4918
  425: 'Unordered Collection',       // RFC 4918
  426: 'Upgrade Required',           // RFC 2817
  428: 'Precondition Required',      // RFC 6585
  429: 'Too Many Requests',          // RFC 6585
  431: 'Request Header Fields Too Large', // RFC 6585
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',    // RFC 2295
  507: 'Insufficient Storage',       // RFC 4918
  508: 'Loop Detected',
  509: 'Bandwidth Limit Exceeded',
  510: 'Not Extended',               // RFC 2774
  511: 'Network Authentication Required' // RFC 6585
};

const kOnExecute = HTTPParser.kOnExecute | 0;

/**
 * [ServerResponse 服务器数据返回对象]
 * @param {[type]} req [description]
 */
function ServerResponse(req) {
  OutgoingMessage.call(this);

  if (req.method === 'HEAD') this._hasBody = false;

  this.sendDate = true;

  if (req.httpVersionMajor < 1 || req.httpVersionMinor < 1) {
    this.useChunkedEncodingByDefault = chunkExpression.test(req.headers.te);
    this.shouldKeepAlive = false;
  }
}
util.inherits(ServerResponse, OutgoingMessage);

ServerResponse.prototype._finish = function _finish() {
  DTRACE_HTTP_SERVER_RESPONSE(this.connection);
  LTTNG_HTTP_SERVER_RESPONSE(this.connection);
  COUNTER_HTTP_SERVER_RESPONSE();
  OutgoingMessage.prototype._finish.call(this);
};


exports.ServerResponse = ServerResponse;

ServerResponse.prototype.statusCode = 200;
ServerResponse.prototype.statusMessage = undefined;

function onServerResponseClose() {
  // EventEmitter.emit makes a copy of the 'close' listeners array before
  // calling the listeners. detachSocket() unregisters onServerResponseClose
  // but if detachSocket() is called, directly or indirectly, by a 'close'
  // listener, onServerResponseClose is still in that copy of the listeners
  // array. That is, in the example below, b still gets called even though
  // it's been removed by a:
  //
  //   var EventEmitter = require('events');
  //   var obj = new EventEmitter();
  //   obj.on('event', a);
  //   obj.on('event', b);
  //   function a() { obj.removeListener('event', b) }
  //   function b() { throw "BAM!" }
  //   obj.emit('event');  // throws
  //
  // Ergo, we need to deal with stale 'close' events and handle the case
  // where the ServerResponse object has already been deconstructed.
  // Fortunately, that requires only a single if check. :-)
  if (this._httpMessage) this._httpMessage.emit('close');
}

ServerResponse.prototype.assignSocket = function assignSocket(socket) {
  assert(!socket._httpMessage);
  socket._httpMessage = this;
  socket.on('close', onServerResponseClose);
  this.socket = socket;
  this.connection = socket;
  this.emit('socket', socket);
  this._flush();
};

ServerResponse.prototype.detachSocket = function detachSocket(socket) {
  assert(socket._httpMessage === this);
  socket.removeListener('close', onServerResponseClose);
  socket._httpMessage = null;
  this.socket = this.connection = null;
};

ServerResponse.prototype.writeContinue = function writeContinue(cb) {
  this._writeRaw('HTTP/1.1 100 Continue' + CRLF + CRLF, 'ascii', cb);
  this._sent100 = true;
};

ServerResponse.prototype._implicitHeader = function _implicitHeader() {
  this.writeHead(this.statusCode);
};

ServerResponse.prototype.writeHead = writeHead;
function writeHead(statusCode, reason, obj) {
  var headers;

  if (typeof reason === 'string') {
    // writeHead(statusCode, reasonPhrase[, headers])
    this.statusMessage = reason;
  } else {
    // writeHead(statusCode[, headers])
    this.statusMessage =
        this.statusMessage || STATUS_CODES[statusCode] || 'unknown';
    obj = reason;
  }
  this.statusCode = statusCode;

  if (this._headers) {
    // Slow-case: when progressive API and header fields are passed.
    if (obj) {
      var keys = Object.keys(obj);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k) this.setHeader(k, obj[k]);
      }
    }
    // only progressive api is used
    headers = this._renderHeaders();
  } else {
    // only writeHead() called
    headers = obj;
  }

  statusCode |= 0;
  if (statusCode < 100 || statusCode > 999)
    throw new RangeError(`Invalid status code: ${statusCode}`);

  if (common._checkInvalidHeaderChar(this.statusMessage))
    throw new Error('Invalid character in statusMessage.');

  var statusLine = 'HTTP/1.1 ' + statusCode.toString() + ' ' +
                   this.statusMessage + CRLF;

  if (statusCode === 204 || statusCode === 304 ||
      (100 <= statusCode && statusCode <= 199)) {
    // RFC 2616, 10.2.5:
    // The 204 response MUST NOT include a message-body, and thus is always
    // terminated by the first empty line after the header fields.
    // RFC 2616, 10.3.5:
    // The 304 response MUST NOT contain a message-body, and thus is always
    // terminated by the first empty line after the header fields.
    // RFC 2616, 10.1 Informational 1xx:
    // This class of status code indicates a provisional response,
    // consisting only of the Status-Line and optional headers, and is
    // terminated by an empty line.
    this._hasBody = false;
  }

  // don't keep alive connections where the client expects 100 Continue
  // but we sent a final status; they may put extra bytes on the wire.
  if (this._expect_continue && !this._sent100) {
    this.shouldKeepAlive = false;
  }

  this._storeHeader(statusLine, headers);
}

ServerResponse.prototype.writeHeader = function writeHeader() {
  this.writeHead.apply(this, arguments);
};

/**
 * [Server 使用net.Server链接]
 * @param {[type]} requestListener [description]
 */
function Server(requestListener) {
  if (!(this instanceof Server)) return new Server(requestListener);
  net.Server.call(this, { allowHalfOpen: true });//全双工

  if (requestListener) {
    this.addListener('request', requestListener);//用户传入了监函数
  }

  /* eslint-disable max-len */
  // Similar option to this. Too lazy to write my own docs.
  // http://www.squid-cache.org/Doc/config/half_closed_clients/
  // http://wiki.squid-cache.org/SquidFaq/InnerWorkings#What_is_a_half-closed_filedescriptor.3F
  /* eslint-enable max-len */
  this.httpAllowHalfOpen = false;//在结束socket的时候使用

  //用这个做链接处理函数处理http请求
  this.addListener('connection', connectionListener);
  //tcp 过期时间设置为2分钟
  this.timeout = 2 * 60 * 1000;

  this._pendingResponseData = 0;
}

//继承net
util.inherits(Server, net.Server);


/**
 * [setTimeout 设置http请求连接超时时间]
 * @param {[type]}   msecs    [description]
 * @param {Function} callback [回调函数]
 */
Server.prototype.setTimeout = function setTimeout(msecs, callback) {
  this.timeout = msecs;
  if (callback)
    this.on('timeout', callback);
  return this;
};


exports.Server = Server;

/**
 * [connectionListener 链接成功之后要做的事]
 * @param  {[type]} socket [description]
 * @return {[type]}        [description]
 */
function connectionListener(socket) {
  var self = this;
  var outgoing = [];
  var incoming = [];
  var outgoingData = 0;

  /**
   * [updateOutgoingData 更新输出数据]
   * @param  {[type]} delta [description]
   * @return {[type]}       [description]
   */
  function updateOutgoingData(delta) {
    // `outgoingData` is an approximate amount of bytes queued through all
    // inactive responses. If more data than the high watermark is queued - we
    // need to pause TCP socket/HTTP parser, and wait until the data will be
    // sent to the client.
    outgoingData += delta;
    if (socket._paused && outgoingData < socket._writableState.highWaterMark)
      return socketOnDrain();
  }
  /**
   * [abortIncoming abort掉输入]
   * @return {[type]} [description]
   */
  function abortIncoming() {
    while (incoming.length) {
      var req = incoming.shift();
      req.emit('aborted');
      req.emit('close');
    }
    // abort socket._httpMessage ?
  }
  /**
   * [serverSocketCloseListener 关闭监听服务]
   * @return {[type]} [description]
   */
  function serverSocketCloseListener() {
    debug('server socket close');
    // mark this parser as reusable
    if (this.parser) { //释放http_parser实例
      freeParser(this.parser, null, this);
    }

    abortIncoming();
  }

  debug('SERVER new http connection');

  httpSocketSetup(socket);//准备读取数据
  // socket.removeListener('drain', ondrain);
  // socket.on('drain', ondrain);

  // If the user has added a listener to the server,
  // request, or response, then it's their responsibility.
  // otherwise, destroy on timeout by default
  if (self.timeout) // 设置链接超时时间
    socket.setTimeout(self.timeout);
  //超时处理
  socket.on('timeout', function() {
    var req = socket.parser && socket.parser.incoming;
    var reqTimeout = req && !req.complete && req.emit('timeout', socket);
    var res = socket._httpMessage;
    var resTimeout = res && res.emit('timeout', socket);
    var serverTimeout = self.emit('timeout', socket);

    if (!reqTimeout && !resTimeout && !serverTimeout)
      socket.destroy();
  });

  //主角登场 http_parser
  var parser = parsers.alloc();//拿出空闲的序列化对象
  parser.reinitialize(HTTPParser.REQUEST);//重新初始化请求头为REQUEST

  // 套接字 + parser解析实例
  parser.socket = socket;
  socket.parser = parser;
  parser.incoming = null;

  // Propagate headers limit from server instance to parser
  if (typeof this.maxHeadersCount === 'number') {
    parser.maxHeaderPairs = this.maxHeadersCount << 1;
  } else {
    // Set default value because parser may be reused from FreeList
    parser.maxHeaderPairs = 2000;
  }

  socket.addListener('error', socketOnError);
  socket.addListener('close', serverSocketCloseListener);

  //关键步骤
  parser.onIncoming = parserOnIncoming;
  socket.on('end', socketOnEnd);

  //重要函数
  socket.on('data', socketOnData);

  // We are consuming socket, so it won't get any actual data
  socket.on('resume', onSocketResume);
  socket.on('pause', onSocketPause);
  //截流
  socket.on('drain', socketOnDrain);

  // Override on to unconsume on `data`, `readable` listeners
  socket.on = socketOnWrap;
  var external = socket._handle._externalStream;//存在外部数据
  if (external) {
    parser._consumed = true;
    parser.consume(external);//消耗掉 ，最终调用onParserExecute
  }
  external = null;
  parser[kOnExecute] = onParserExecute;

  // TODO(isaacs): Move all these functions out of here
  function socketOnError(e) {
    // Ignore further errors
    this.removeListener('error', socketOnError);
    this.on('error', () => {});

    if (!self.emit('clientError', e, this))
      this.destroy(e);
  }

  /**
   * [socketOnData 接收socket数据]
   * @param  {[type]} d [description]
   * @return {[type]}   [description]
   */
  function socketOnData(d) {
    assert(!socket._paused);
    debug('SERVER socketOnData %d', d.length);
    var ret = parser.execute(d); //接收数据咯

    onParserExecuteCommon(ret, d);
  }

  //执行解析
  function onParserExecute(ret, d) {
    socket._unrefTimer();
    debug('SERVER socketOnParserExecute %d', ret);
    onParserExecuteCommon(ret, undefined);
  }
  /**
   * [onParserExecuteCommon 解析执行监听函数]
   * @param  {[type]} ret [description]
   * @param  {[type]} d   [description]
   * @return {[type]}     [description]
   */
  function onParserExecuteCommon(ret, d) {
    if (ret instanceof Error) {
      debug('parse error');
      socketOnError.call(socket, ret);
    } else if (parser.incoming && parser.incoming.upgrade) {
      // Upgrade or CONNECT
      var bytesParsed = ret;
      var req = parser.incoming;
      debug('SERVER upgrade or connect', req.method);

      if (!d)
        d = parser.getCurrentBuffer();

      socket.removeListener('data', socketOnData);
      socket.removeListener('end', socketOnEnd);
      socket.removeListener('close', serverSocketCloseListener);
      unconsume(parser, socket);
      parser.finish();
      freeParser(parser, req, null);
      parser = null;

      var eventName = req.method === 'CONNECT' ? 'connect' : 'upgrade';
      if (self.listenerCount(eventName) > 0) {
        debug('SERVER have listener for %s', eventName);
        var bodyHead = d.slice(bytesParsed, d.length);

        // TODO(isaacs): Need a way to reset a stream to fresh state
        // IE, not flowing, and not explicitly paused.
        socket._readableState.flowing = null;
        self.emit(eventName, req, socket, bodyHead);//触发连接请求
      } else {
        // Got upgrade header or CONNECT method, but have no handler.
        socket.destroy();
      }
    }

    if (socket._paused && socket.parser) {
      // onIncoming paused the socket, we should pause the parser as well
      debug('pause parser');
      socket.parser.pause();//暂停解析
    }
  }
  /**
   * [socketOnEnd socket结束]
   * @return {[type]} [description]
   */
  function socketOnEnd() {
    var socket = this;
    var ret = parser.finish();//结束

    if (ret instanceof Error) {
      debug('parse error');
      socketOnError.call(socket, ret);
      return;
    }
    //如果http设置为不是全双工
    if (!self.httpAllowHalfOpen) {
      abortIncoming();
      if (socket.writable) socket.end();
    } else if (outgoing.length) {
      outgoing[outgoing.length - 1]._last = true;
    } else if (socket._httpMessage) {
      socket._httpMessage._last = true;
    } else {
      if (socket.writable) socket.end();
    }
  }


  // The following callback is issued after the headers have been read on a
  // new message. In this callback we setup the response object and pass it
  // to the user.

  socket._paused = false;
  /**
   * [socketOnDrain socket是否需要节流]
   * @return {[type]} [description]
   */
  function socketOnDrain() {
    var needPause = outgoingData > socket._writableState.highWaterMark;//超过最高缓存应该暂停

    // If we previously paused, then start reading again.
    if (socket._paused && !needPause) {
      socket._paused = false;
      if (socket.parser)
        socket.parser.resume();
      socket.resume();//将流从暂停模式切换到流动模式
    }
  }
  /**
   * [parserOnIncoming 解析报文头完成之后]
   * @param  {[type]} req             [description]
   * @param  {[type]} shouldKeepAlive [description]
   * @return {[type]}                 [description]
   */
  function parserOnIncoming(req, shouldKeepAlive) {
    incoming.push(req);
    //创建响应对象
    var res = new ServerResponse(req);
    res._onPendingData = updateOutgoingData;
    res.shouldKeepAlive = shouldKeepAlive;
    // 完成响应
    res.on('finish', resOnFinish);
    function resOnFinish() {
      // Usually the first incoming element should be our request.  it may
      // be that in the case abortIncoming() was called that the incoming
      // array will be empty.
      assert(incoming.length === 0 || incoming[0] === req);

      incoming.shift();

      // if the user never called req.read(), and didn't pipe() or
      // .resume() or .on('data'), then we call req._dump() so that the
      // bytes will be pulled off the wire.
      if (!req._consuming && !req._readableState.resumeScheduled)
        req._dump();
      //分离套接字
      res.detachSocket(socket);

      if (res._last) {
        socket.destroySoon();
      } else {
        // start sending the next message
        var m = outgoing.shift();
        if (m) {
          m.assignSocket(socket);
        }
      }
    }
    //当要POST的数据大于1024字节的时候, curl并不会直接就发起POST请求, 而是会分为俩步
    //1. 发送一个请求, 包含一个Expect:100-continue, 询问Server使用愿意接受数据
    //2. 接收到Server返回的100-continue应答以后, 才把数据POST给Server
    if (req.headers.expect !== undefined &&
        (req.httpVersionMajor === 1 && req.httpVersionMinor === 1)) {
      if (continueExpression.test(req.headers.expect)) {
        res._expect_continue = true;

        if (self.listenerCount('checkContinue') > 0) {
          self.emit('checkContinue', req, res);
        } else {
          res.writeContinue();//确认接收
          self.emit('request', req, res);//触发请求
        }
      } else { //服务器不接受post大于1024字节的请求
        if (self.listenerCount('checkExpectation') > 0) {
          self.emit('checkExpectation', req, res);
        } else {
          res.writeHead(417);
          res.end();
        }
      }
    } else {
      self.emit('request', req, res);//触发请求事件
    }
    return false; // Not a HEAD response. (Not even a response!)
  }
}
exports._connectionListener = connectionListener;

function onSocketResume() {
  // It may seem that the socket is resumed, but this is an enemy's trick to
  // deceive us! `resume` is emitted asynchronously, and may be called from
  // `incoming.readStart()`. Stop the socket again here, just to preserve the
  // state.
  //
  // We don't care about stream semantics for the consumed socket anyway.
  if (this._paused) {
    this.pause();
    return;
  }

  if (this._handle && !this._handle.reading) {
    this._handle.reading = true;
    this._handle.readStart();
  }
}

function onSocketPause() {
  if (this._handle && this._handle.reading) {
    this._handle.reading = false;
    this._handle.readStop();
  }
}

function unconsume(parser, socket) {
  if (socket._handle) {
    if (parser._consumed)
      parser.unconsume(socket._handle._externalStream);
    parser._consumed = false;
    socket.removeListener('pause', onSocketPause);
    socket.removeListener('resume', onSocketResume);
  }
}

function socketOnWrap(ev, fn) {
  var res = net.Socket.prototype.on.call(this, ev, fn);
  if (!this.parser) {
    this.on = net.Socket.prototype.on;
    return res;
  }

  if (ev === 'data' || ev === 'readable')
    unconsume(this.parser, this);

  return res;
}
