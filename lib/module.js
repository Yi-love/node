'use strict';

//加载原生模块 bootstrap_node.js
//详情：NativeModule.require
const NativeModule = require('native_module');
const util = require('util');
const internalModule = require('internal/module');
const vm = require('vm');
const assert = require('assert').ok;
const fs = require('fs');
const internalFS = require('internal/fs');
const path = require('path');
const internalModuleReadFile = process.binding('fs').internalModuleReadFile;
const internalModuleStat = process.binding('fs').internalModuleStat;
const preserveSymlinks = !!process.binding('config').preserveSymlinks;

// If obj.hasOwnProperty has been overridden, then calling
// obj.hasOwnProperty(prop) will break.
// See: https://github.com/joyent/node/issues/1707
// 防止被覆盖
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

/**
 * [stat 获取文件类型 例如：file  dir]
 * @param  {[type]} filename [description]
 * @return {[type]}          [description]
 */
function stat(filename) {
  filename = path._makeLong(filename);//文件路径
  const cache = stat.cache;//缓存
  if (cache !== null) {
    const result = cache.get(filename);
    if (result !== undefined) return result;//返回文件类型
  }
  const result = internalModuleStat(filename);//使用c++核心模块
  if (cache !== null) cache.set(filename, result);//设置缓存
  return result;
}
stat.cache = null;//缓存

/**
 * [Module 模块加载对象]
 * @param {[type]} id     [description]
 * @param {[type]} parent [description]
 */
function Module(id, parent) {
  this.id = id;
  this.exports = {};
  this.parent = parent;
  if (parent && parent.children) {
    parent.children.push(this);
  }

  this.filename = null;
  this.loaded = false;
  this.children = [];
}
module.exports = Module;

Module._cache = {};
Module._pathCache = {};
Module._extensions = {};
var modulePaths = [];
Module.globalPaths = [];

Module.wrapper = NativeModule.wrapper;
Module.wrap = NativeModule.wrap;
Module._debug = util.debuglog('module');

// We use this alias for the preprocessor that filters it out
const debug = Module._debug;


// given a module name, and a list of paths to test, returns the first
// matching file in the following precedence.
//
// require("a.<ext>")
//   -> a.<ext>
//
// require("a")
//   -> a
//   -> a.<ext>
//   -> a/index.<ext>

// check if the directory is a package.json dir
const packageMainCache = {};
/**
 * [readPackage 获取包中的入口文件]
 * @param  {[type]} requestPath [description]
 * @return {[type]}             [description]
 */
function readPackage(requestPath) {
  if (hasOwnProperty(packageMainCache, requestPath)) {
    return packageMainCache[requestPath];
  }

  const jsonPath = path.resolve(requestPath, 'package.json');
  const json = internalModuleReadFile(path._makeLong(jsonPath));

  if (json === undefined) {
    return false;
  }

  try {
    var pkg = packageMainCache[requestPath] = JSON.parse(json).main;
  } catch (e) {
    e.path = jsonPath;
    e.message = 'Error parsing ' + jsonPath + ': ' + e.message;
    throw e;
  }
  return pkg;
}

/**
 * [tryPackage 获取require文件的绝对路径]
 * @param  {[type]}  requestPath [description]
 * @param  {[type]}  exts        [description]
 * @param  {Boolean} isMain      [description]
 * @return {[type]}              [description]
 */
function tryPackage(requestPath, exts, isMain) {
  var pkg = readPackage(requestPath);

  if (!pkg) return false;

  var filename = path.resolve(requestPath, pkg);
  return tryFile(filename, isMain) ||
         tryExtensions(filename, exts, isMain) ||
         tryExtensions(path.resolve(filename, 'index'), exts, isMain);
}

// In order to minimize unnecessary lstat() calls,
// this cache is a list of known-real paths.
// Set to an empty Map to reset.
const realpathCache = new Map();

// check if the file exists and is not a directory
// if using --preserve-symlinks and isMain is false,
// keep symlinks intact, otherwise resolve to the
// absolute realpath.
function tryFile(requestPath, isMain) {
  const rc = stat(requestPath);
  if (preserveSymlinks && !isMain) {
    return rc === 0 && path.resolve(requestPath);
  }
  return rc === 0 && toRealPath(requestPath);//文件
}
/**
 * [toRealPath 根据文件路径加载]
 * @param  {[type]} requestPath [description]
 * @return {[type]}             [description]
 */
function toRealPath(requestPath) {
  return fs.realpathSync(requestPath, {
    [internalFS.realpathCacheKey]: realpathCache
  });
}

// given a path check a the file exists with any of the set extensions
function tryExtensions(p, exts, isMain) {
  for (var i = 0; i < exts.length; i++) {
    const filename = tryFile(p + exts[i], isMain);

    if (filename) {
      return filename;
    }
  }
  return false;
}

var warned = false;
/**
 * [_findPath 查找reqiure文件路径]
 * @param  {[type]}  request [description]
 * @param  {[type]}  paths   [description]
 * @param  {Boolean} isMain  [description]
 * @return {[type]}          [description]
 */
Module._findPath = function(request, paths, isMain) {
  if (path.isAbsolute(request)) {
    paths = [''];
  } else if (!paths || paths.length === 0) {
    return false;
  }

  const cacheKey = JSON.stringify({request: request, paths: paths});
  if (Module._pathCache[cacheKey]) {
    return Module._pathCache[cacheKey];
  }

  var exts;
  const trailingSlash = request.length > 0 &&
                        request.charCodeAt(request.length - 1) === 47/*/*/;

  // For each path
  for (var i = 0; i < paths.length; i++) {
    // Don't search further if path doesn't exist
    const curPath = paths[i];
    if (curPath && stat(curPath) < 1) continue;
    var basePath = path.resolve(curPath, request);
    var filename;

    const rc = stat(basePath);
    if (!trailingSlash) {
      if (rc === 0) {  // File.
        if (preserveSymlinks && !isMain) {
          filename = path.resolve(basePath);
        } else {
          filename = toRealPath(basePath);
        }
      } else if (rc === 1) {  // Directory.
        if (exts === undefined)
          exts = Object.keys(Module._extensions);
        filename = tryPackage(basePath, exts, isMain);
      }

      if (!filename) {
        // try it with each of the extensions
        if (exts === undefined)
          exts = Object.keys(Module._extensions);
        filename = tryExtensions(basePath, exts, isMain);
      }
    }

    if (!filename && rc === 1) {  // Directory.
      if (exts === undefined)
        exts = Object.keys(Module._extensions);
      filename = tryPackage(basePath, exts, isMain);
    }

    if (!filename && rc === 1) {  // Directory.
      // try it with each of the extensions at "index"
      if (exts === undefined)
        exts = Object.keys(Module._extensions);
      filename = tryExtensions(path.resolve(basePath, 'index'), exts, isMain);
    }

    if (filename) {
      // Warn once if '.' resolved outside the module dir
      if (request === '.' && i > 0) {
        if (!warned) {
          warned = true;
          process.emitWarning(
            'warning: require(\'.\') resolved outside the package ' +
            'directory. This functionality is deprecated and will be removed ' +
            'soon.',
            'DeprecationWarning');
        }
      }

      Module._pathCache[cacheKey] = filename;
      return filename;
    }
  }
  return false;
};

// 'node_modules' character codes reversed
var nmChars = [ 115, 101, 108, 117, 100, 111, 109, 95, 101, 100, 111, 110 ];
var nmLen = nmChars.length;
if (process.platform === 'win32') {
  // 'from' is the __dirname of the module.
  Module._nodeModulePaths = function(from) {
    // guarantee that 'from' is absolute.
    from = path.resolve(from);

    // note: this approach *only* works when the path is guaranteed
    // to be absolute.  Doing a fully-edge-case-correct path.split
    // that works on both Windows and Posix is non-trivial.

    // return root node_modules when path is 'D:\\'.
    // path.resolve will make sure from.length >=3 in Windows.
    if (from.charCodeAt(from.length - 1) === 92/*\*/ &&
        from.charCodeAt(from.length - 2) === 58/*:*/)
      return [from + 'node_modules'];

    const paths = [];
    var p = 0;
    var last = from.length;
    for (var i = from.length - 1; i >= 0; --i) {
      const code = from.charCodeAt(i);
      // The path segment separator check ('\' and '/') was used to get
      // node_modules path for every path segment.
      // Use colon as an extra condition since we can get node_modules
      // path for dirver root like 'C:\node_modules' and don't need to
      // parse driver name.
      if (code === 92/*\*/ || code === 47/*/*/ || code === 58/*:*/) {
        if (p !== nmLen)
          paths.push(from.slice(0, last) + '\\node_modules');
        last = i;
        p = 0;
      } else if (p !== -1) {
        if (nmChars[p] === code) {
          ++p;
        } else {
          p = -1;
        }
      }
    }

    return paths;
  };
} else { // posix
  // 'from' is the __dirname of the module.
  Module._nodeModulePaths = function(from) {
    // guarantee that 'from' is absolute.
    from = path.resolve(from);
    // Return early not only to avoid unnecessary work, but to *avoid* returning
    // an array of two items for a root: [ '//node_modules', '/node_modules' ]
    if (from === '/')
      return ['/node_modules'];

    // note: this approach *only* works when the path is guaranteed
    // to be absolute.  Doing a fully-edge-case-correct path.split
    // that works on both Windows and Posix is non-trivial.
    const paths = [];
    var p = 0;
    var last = from.length;
    for (var i = from.length - 1; i >= 0; --i) {
      const code = from.charCodeAt(i);
      if (code === 47/*/*/) {
        if (p !== nmLen)
          paths.push(from.slice(0, last) + '/node_modules');
        last = i;
        p = 0;
      } else if (p !== -1) {
        if (nmChars[p] === code) {
          ++p;
        } else {
          p = -1;
        }
      }
    }

    // Append /node_modules to handle root paths.
    paths.push('/node_modules');

    return paths;
  };
}


// 'index.' character codes
var indexChars = [ 105, 110, 100, 101, 120, 46 ];
var indexLen = indexChars.length;
/**
 * [_resolveLookupPaths description]
 * @param  {[type]} request [description]
 * @param  {[type]} parent  [description]
 * @return {[type]}         [description]
 */
Module._resolveLookupPaths = function(request, parent) {
  //原生模块
  if (NativeModule.nonInternalExists(request)) {
    return [request, []];
  }

  var reqLen = request.length;
  // Check for relative path
  // 检测相对路径
  if (reqLen < 2 ||
      request.charCodeAt(0) !== 46/*.*/ ||
      (request.charCodeAt(1) !== 46/*.*/ && request.charCodeAt(1) !== 47/*/*/)) {
    var paths = modulePaths;
    //父亲模块
    if (parent) {
      if (!parent.paths)
        paths = parent.paths = [];
      else
        paths = parent.paths.concat(paths);//父亲模块的paths集合
    }

    // Maintain backwards compat with certain broken uses of require('.')
    // by putting the module's directory in front of the lookup paths.
    if (request === '.') { //加载当前文件夹
      if (parent && parent.filename) {
        paths.unshift(path.dirname(parent.filename));
      } else {
        paths.unshift(path.resolve(request));
      }
    }

    return [request, paths];
  }

  // with --eval, parent.id is not set and parent.filename is null
  if (!parent || !parent.id || !parent.filename) {
    // make require('./path/to/foo') work - normally the path is taken
    // from realpath(__filename) but with eval there is no filename
    var mainPaths = ['.'].concat(Module._nodeModulePaths('.'), modulePaths);
    return [request, mainPaths];
  }

  // Is the parent an index module?
  // We can assume the parent has a valid extension,
  // as it already has been accepted as a module.
  const base = path.basename(parent.filename);
  var parentIdPath;
  if (base.length > indexLen) {
    var i = 0;
    for (; i < indexLen; ++i) {
      if (indexChars[i] !== base.charCodeAt(i))
        break;
    }
    if (i === indexLen) {
      // We matched 'index.', let's validate the rest
      for (; i < base.length; ++i) {
        const code = base.charCodeAt(i);
        if (code !== 95/*_*/ &&
            (code < 48/*0*/ || code > 57/*9*/) &&
            (code < 65/*A*/ || code > 90/*Z*/) &&
            (code < 97/*a*/ || code > 122/*z*/))
          break;
      }
      if (i === base.length) {
        // Is an index module
        parentIdPath = parent.id;
      } else {
        // Not an index module
        parentIdPath = path.dirname(parent.id);
      }
    } else {
      // Not an index module
      parentIdPath = path.dirname(parent.id);
    }
  } else {
    // Not an index module
    parentIdPath = path.dirname(parent.id);
  }
  var id = path.resolve(parentIdPath, request);

  // make sure require('./path') and require('path') get distinct ids, even
  // when called from the toplevel js file
  if (parentIdPath === '.' && id.indexOf('/') === -1) {
    id = './' + id;
  }

  debug('RELATIVE: requested: %s set ID to: %s from %s', request, id,
        parent.id);

  return [id, [path.dirname(parent.filename)]];
};


// Check the cache for the requested file.
// 1. If a module already exists in the cache: return its exports object.
// 2. If the module is native: call `NativeModule.require()` with the
//    filename and return the result.
// 3. Otherwise, create a new module for the file and save it to the cache.
//    Then have it load  the file contents before returning its exports
//    object.
/**
 * [_load 加载用户模块]
 * @param  {[type]}  request [模块名]
 * @param  {[type]}  parent  [父亲对象]
 * @param  {Boolean} isMain  [主入口]
 * @return {[type]}          [description]
 */
Module._load = function(request, parent, isMain) {
  if (parent) {
    debug('Module._load REQUEST %s parent: %s', request, parent.id);
  }
  //获取文件绝对路径
  var filename = Module._resolveFilename(request, parent, isMain);

  //查看是否已经缓存
  var cachedModule = Module._cache[filename];
  if (cachedModule) {
    return cachedModule.exports;
  }
  //原生模块
  if (NativeModule.nonInternalExists(filename)) {
    debug('load native module %s', request);
    return NativeModule.require(filename);
  }

  var module = new Module(filename, parent);//创建新模块

  if (isMain) { //主模块
    process.mainModule = module;
    module.id = '.';
  }

  Module._cache[filename] = module;//缓存

  tryModuleLoad(module, filename);//尝试加载模块

  return module.exports;//返回模块
};

/**
 * [tryModuleLoad 尝试加载模块]
 * @param  {[type]} module   [description]
 * @param  {[type]} filename [description]
 * @return {[type]}          [description]
 */
function tryModuleLoad(module, filename) {
  var threw = true;
  try {
    module.load(filename);
    threw = false;
  } finally {
    if (threw) { //报错
      delete Module._cache[filename];
    }
  }
}
/**
 * [_resolveFilename 获取文件路径]
 * @param  {[type]}  request [文件名/模块]
 * @param  {[type]}  parent  [description]
 * @param  {Boolean} isMain  [description]
 * @return {[type]}          [description]
 */
Module._resolveFilename = function(request, parent, isMain) {
  if (NativeModule.nonInternalExists(request)) { //原生模块直接返回
    return request;
  }
  //获取文件路径相关信息
  var resolvedModule = Module._resolveLookupPaths(request, parent);
  var id = resolvedModule[0];
  var paths = resolvedModule[1];

  // look up the filename first, since that's the cache key.
  debug('looking for %j in %j', id, paths);
  //获取文件路径
  var filename = Module._findPath(request, paths, isMain);
  if (!filename) {
    var err = new Error("Cannot find module '" + request + "'");
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return filename;
};


// Given a file name, pass it to the proper extension handler.
/**
 * [load 加载模块]
 * @param  {[type]} filename [文件名]
 * @return {[type]}          [description]
 */
Module.prototype.load = function(filename) {
  debug('load %j for module %j', filename, this.id);

  assert(!this.loaded);
  this.filename = filename;
  //相关路径数组 主要是node_modules路径
  /*
  [ 'E:\\node\\node\\node_modules',
    'E:\\node\\node_modules',
    'E:\\node_modules']*/
  this.paths = Module._nodeModulePaths(path.dirname(filename));

  var extension = path.extname(filename) || '.js';
  if (!Module._extensions[extension]) extension = '.js';
  //根据文件类型加载模块
  Module._extensions[extension](this, filename);
  this.loaded = true;
};


// Loads a module at the given file path. Returns that module's
// `exports` property.
Module.prototype.require = function(path) {
  assert(path, 'missing path');
  assert(typeof path === 'string', 'path must be a string');
  return Module._load(path, this, /* isMain */ false);
};


// Resolved path to process.argv[1] will be lazily placed here
// (needed for setting breakpoint when called with --debug-brk)
var resolvedArgv;


// Run the file contents in the correct scope or sandbox. Expose
// the correct helper variables (require, module, exports) to
// the file.
// Returns exception, if any.
Module.prototype._compile = function(content, filename) {
  // Remove shebang
  var contLen = content.length;
  if (contLen >= 2) {
    if (content.charCodeAt(0) === 35/*#*/ &&
        content.charCodeAt(1) === 33/*!*/) {
      if (contLen === 2) {
        // Exact match
        content = '';
      } else {
        // Find end of shebang line and slice it off
        var i = 2;
        for (; i < contLen; ++i) {
          var code = content.charCodeAt(i);
          if (code === 10/*\n*/ || code === 13/*\r*/)
            break;
        }
        if (i === contLen)
          content = '';
        else {
          // Note that this actually includes the newline character(s) in the
          // new output. This duplicates the behavior of the regular expression
          // that was previously used to replace the shebang line
          content = content.slice(i);
        }
      }
    }
  }

  // create wrapper function
  // 给文件添加头和尾
  // '(function (exports, require, module, __filename, __dirname) { ',
  //  '\n});'
  var wrapper = Module.wrap(content);
  //使用vm模块执行js
  var compiledWrapper = vm.runInThisContext(wrapper, {
    filename: filename,
    lineOffset: 0,
    displayErrors: true
  });

  if (process._debugWaitConnect && process._eval == null) {
    if (!resolvedArgv) {
      // we enter the repl if we're not given a filename argument.
      if (process.argv[1]) {
        resolvedArgv = Module._resolveFilename(process.argv[1], null);
      } else {
        resolvedArgv = 'repl';
      }
    }

    // Set breakpoint on module start
    if (filename === resolvedArgv) {
      delete process._debugWaitConnect;
      const Debug = vm.runInDebugContext('Debug');
      Debug.setBreakPoint(compiledWrapper, 0, 0);
    }
  }
  var dirname = path.dirname(filename);//不管是文件还是目录，都会返回上一级目录
  //获取require函数
  var require = internalModule.makeRequireFunction.call(this);
  //这就是 exports 和module.exports的区别       module = this  exports = module.exports
  var args = [this.exports, require, this, filename, dirname];
  var depth = internalModule.requireDepth;//依赖模块
  if (depth === 0) stat.cache = new Map();
  //执行js文件
  var result = compiledWrapper.apply(this.exports, args);
  if (depth === 0) stat.cache = null;
  return result;
};


// Native extension for .js
Module._extensions['.js'] = function(module, filename) {
  var content = fs.readFileSync(filename, 'utf8');
  module._compile(internalModule.stripBOM(content), filename);
};


// Native extension for .json
Module._extensions['.json'] = function(module, filename) {
  var content = fs.readFileSync(filename, 'utf8');
  try {
    module.exports = JSON.parse(internalModule.stripBOM(content));
  } catch (err) {
    err.message = filename + ': ' + err.message;
    throw err;
  }
};


//Native extension for .node
Module._extensions['.node'] = function(module, filename) {
  return process.dlopen(module, path._makeLong(filename));
};


// bootstrap main module.
/**
 * [runMain 开始执行入口文件]
 * @return {[type]} [description]
 */
Module.runMain = function() {
  // Load the main module--the command line argument.
  Module._load(process.argv[1], null, true);
  // Handle any nextTicks added in the first tick of the program
  // 处理nextTick添加的回调函数
  process._tickCallback();
};

Module._initPaths = function() {
  const isWindows = process.platform === 'win32';

  var homeDir;
  if (isWindows) {
    homeDir = process.env.USERPROFILE;
  } else {
    homeDir = process.env.HOME;
  }

  var paths = [path.resolve(process.execPath, '..', '..', 'lib', 'node')];

  if (homeDir) {
    paths.unshift(path.resolve(homeDir, '.node_libraries'));
    paths.unshift(path.resolve(homeDir, '.node_modules'));
  }

  var nodePath = process.env['NODE_PATH'];
  if (nodePath) {
    paths = nodePath.split(path.delimiter).filter(function(path) {
      return !!path;
    }).concat(paths);
  }

  modulePaths = paths;

  // clone as a shallow copy, for introspection.
  Module.globalPaths = modulePaths.slice(0);
};

Module._preloadModules = function(requests) {
  if (!Array.isArray(requests))
    return;

  // Preloaded modules have a dummy parent module which is deemed to exist
  // in the current working directory. This seeds the search path for
  // preloaded modules.
  var parent = new Module('internal/preload', null);
  try {
    parent.paths = Module._nodeModulePaths(process.cwd());//[]
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
  requests.forEach(function(request) {
    parent.require(request);
  });
};

Module._initPaths();

// backwards compatibility
Module.Module = Module;
