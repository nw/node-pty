/**
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import * as net from 'net';
import * as path from 'path';
import * as extend from 'extend';
import { inherits } from 'util';
import * as Terminal from './pty';

let pty;
try {
  pty = require(path.join('..', 'build', 'Release', 'pty.node'));
} catch (e) {
  pty = require(path.join('..', 'build', 'Debug', 'pty.node'));
};

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 30;

/**
 * Agent. Internal class.
 *
 * Everytime a new pseudo terminal is created it is contained
 * within agent.exe. When this process is started there are two
 * available named pipes (control and data socket).
 */

function Agent(file, args, env, cwd, cols, rows, debug) {
  const self = this;

  // Unique identifier per pipe created.
  const timestamp = Date.now();

  // Sanitize input variable.
  file = file;
  cwd = path.resolve(cwd);

  // Compose command line
  const cmdline = [file];
  Array.prototype.push.apply(cmdline, args);
  const cmdlineFlat = argvToCommandLine(cmdline);

  // Open pty session.
  const term = pty.startProcess(file, cmdlineFlat, env, cwd, cols, rows, debug);
  this.dataPipeIn = term.conin;
  this.dataPipeOut = term.conout;

  // Terminal pid.
  this.pid = term.pid;

  // Not available on windows.
  this.fd = term.fd;

  // Generated incremental number that has no real purpose besides
  // using it as a terminal id.
  this.pty = term.pty;

  // Create terminal pipe IPC channel and forward to a local unix socket.
  this.ptyOutSocket = new net.Socket();
  this.ptyOutSocket.setEncoding('utf8');
  this.ptyOutSocket.connect(this.dataPipeOut, function () {
    // TODO: Emit event on agent instead of socket?

    // Emit ready event.
    self.ptyOutSocket.emit('ready_datapipe');
  });

  this.ptyInSocket = new net.Socket();
  this.ptyInSocket.setEncoding('utf8');
  this.ptyInSocket.connect(this.dataPipeIn);
  // TODO: Wait for ready event?
}

/**
 * Terminal
 */

/*
var pty = require('./');

var term = pty.fork('cmd.exe', [], {
  name: 'Windows Shell',
  cols: 80,
  rows: 30,
  cwd: process.env.HOME,
  env: process.env,
  debug: true
});

term.on('data', function(data) {
  console.log(data);
});
*/

export function WindowsTerminal(file, args, opt) {

  const self = this;
  let env, cwd, name, cols, rows, term, agent, debug;

  // Backward compatibility.
  if (typeof args === 'string') {
    opt = {
      name: arguments[1],
      cols: arguments[2],
      rows: arguments[3],
      cwd: process.env.HOME
    };
    args = [];
  }

  // Arguments.
  args = args || [];
  file = file || 'cmd.exe';
  opt = opt || {};

  opt.env = opt.env || process.env;
  env = extend({}, opt.env);

  cols = opt.cols || DEFAULT_COLS;
  rows = opt.rows || DEFAULT_ROWS;
  cwd = opt.cwd || process.cwd();
  name = opt.name || env.TERM || 'Windows Shell';
  debug = opt.debug || false;

  env.TERM = name;

  // Initialize environment variables.
  env = environ(env);

  // If the terminal is ready
  this.isReady = false;

  // Functions that need to run after `ready` event is emitted.
  this.deferreds = [];

  // Create new termal.
  this.agent = new Agent(file, args, env, cwd, cols, rows, debug);

  // The dummy socket is used so that we can defer everything
  // until its available.
  this.socket = this.agent.ptyOutSocket;

  // The terminal socket when its available
  this.dataPipe = null;

  // Not available until `ready` event emitted.
  this.pid = this.agent.pid;
  this.fd = this.agent.fd;
  this.pty = this.agent.pty;

  // The forked windows terminal is not available
  // until `ready` event is emitted.
  this.socket.on('ready_datapipe', function () {

    // These events needs to be forwarded.
    ['connect', 'data', 'end', 'timeout', 'drain'].forEach(function(event) {
      self.socket.on(event, function(data) {

        // Wait until the first data event is fired
        // then we can run deferreds.
        if (!self.isReady && event === 'data') {

          // Terminal is now ready and we can
          // avoid having to defer method calls.
          self.isReady = true;

          // Execute all deferred methods
          self.deferreds.forEach(function(fn) {
            // NB! In order to ensure that `this` has all
            // its references updated any variable that
            // need to be available in `this` before
            // the deferred is run has to be declared
            // above this forEach statement.
            fn.run();
          });

          // Reset
          self.deferreds = [];

        }
      });
    });

    // Resume socket.
    self.socket.resume();

    // Shutdown if `error` event is emitted.
    self.socket.on('error', function (err) {

      // Close terminal session.
      self._close();

      // EIO, happens when someone closes our child
      // process: the only process in the terminal.
      // node < 0.6.14: errno 5
      // node >= 0.6.14: read EIO
      if (err.code) {
        if (~err.code.indexOf('errno 5') || ~err.code.indexOf('EIO')) return;
      }

      // Throw anything else.
      if (self.listeners('error').length < 2) {
        throw err;
      }

    });

    // Cleanup after the socket is closed.
    self.socket.on('close', function () {
      self.emit('exit', null);
      self._close();
    });

  });

  this.file = file;
  this.name = name;
  this.cols = cols;
  this.rows = rows;

  this.readable = true;
  this.writable = true;
}

// Inherit from pty.js
inherits(WindowsTerminal, Terminal);

/**
 * Events
 */

/**
 * openpty
 */

WindowsTerminal.prototype.open = function () {
  throw new Error('open() not supported on windows, use Fork() instead.');
};

/**
 * Events
 */

WindowsTerminal.prototype.write = function(data) {
  defer(this, function() {
    this.agent.ptyInSocket.write(data);
  });
};

/**
 * TTY
 */

WindowsTerminal.prototype.resize = function (cols, rows) {
  defer(this, function() {

    cols = cols || DEFAULT_COLS;
    rows = rows || DEFAULT_ROWS;

    this.cols = cols;
    this.rows = rows;

    pty.resize(this.pid, cols, rows);
  });
};

WindowsTerminal.prototype.destroy = function () {
  defer(this, function() {
    this.kill();
  });
};

WindowsTerminal.prototype.kill = function (sig) {
  defer(this, function() {
    if (sig !== undefined) {
      throw new Error('Signals not supported on windows.');
    }
    this._close();
    pty.kill(this.pid);
  });
};

WindowsTerminal.prototype.__defineGetter__('process', function () {
  return this.name;
});

/**
 * Helpers
 */

function defer(terminal, deferredFn) {

  // Ensure that this method is only used within Terminal class.
  if (!(terminal instanceof WindowsTerminal)) {
    throw new Error('Must be instanceof WindowsTerminal');
  }

  // If the terminal is ready, execute.
  if (terminal.isReady) {
    deferredFn.apply(terminal, null);
    return;
  }

  // Queue until terminal is ready.
  terminal.deferreds.push({
    run: function() {
      // Run deffered.
      deferredFn.apply(terminal, null);
    }
  });
}

function environ(env) {
  const keys = Object.keys(env || {});
  const pairs = [];

  for (let i = 0; i < keys.length; i++) {
    pairs.push(keys[i] + '=' + env[keys[i]]);
  }

  return pairs;
}

// Convert argc/argv into a Win32 command-line following the escaping convention
// documented on MSDN.  (e.g. see CommandLineToArgvW documentation)
// Copied from winpty project.
function argvToCommandLine(argv) {
  let result = '';
  for (let argIndex = 0; argIndex < argv.length; argIndex++) {
    if (argIndex > 0) {
      result += ' ';
    }
    const arg = argv[argIndex];
    const quote =
      arg.indexOf(' ') !== -1 ||
      arg.indexOf('\t') !== -1 ||
      arg === '';
    if (quote) {
      result += '\"';
    }
    let bsCount = 0;
    for (let i = 0; i < arg.length; i++) {
      const p = arg[i];
      if (p === '\\') {
        bsCount++;
      } else if (p === '"') {
        result += repeatText('\\', bsCount * 2 + 1);
        result += '"';
        bsCount = 0;
      } else {
        result += repeatText('\\', bsCount);
        bsCount = 0;
        result += p;
      }
    }
    if (quote) {
      result += repeatText('\\', bsCount * 2);
      result += '\"';
    } else {
      result += repeatText('\\', bsCount);
    }
  }
  return result;
}

function repeatText(text: string, count: number): string {
  let result = text;
  for (let i = 1; i < count; i++) {
    result += text;
  }
  return result;
}