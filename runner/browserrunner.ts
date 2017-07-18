/**
 * @license
 * Copyright (c) 2014 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import * as cleankill from 'cleankill';
import * as wd from 'wd';
import { Config } from './config';

export interface Stats {
  status: string;
  passing?: number;
  pending?: number;
  failing?: number;
}

export interface BrowserDef extends wd.Capabilities {
  id: number;
  url: string;
  sessionId: string;
  deviceName?: string;
  variant?: string;
  runnerCtor?: BrowserRunnerCtor;
}

export interface BrowserRunnerCtor {
  new(emitter: NodeJS.EventEmitter, def: BrowserDef, options: Config, url: string,
    waitFor?: Promise<void>): BrowserRunner;
}

export function createBrowserRunner(ctor: BrowserRunnerCtor, emitter: NodeJS.EventEmitter,
  def: BrowserDef, options: Config, url: string, waitFor?: Promise<void>): BrowserRunner {
  return new ctor(emitter, def, options, url, waitFor);
}

// Browser abstraction, responsible for spinning up a browser instance via wd.js
// and executing runner.html test files passed in options.files
export abstract class BrowserRunner {
  timeout: number;
  stats: Stats;
  timeoutId: NodeJS.Timer;
  emitter: NodeJS.EventEmitter;
  def: BrowserDef;
  options: Config;
  donePromise: Promise<void>;

  /**
   * The url of the initial page to load in the browser when starting tests.
   */
  url: string;

  get testUrl(): string {
    const paramDelim = (this.url.indexOf('?') === -1 ? '?' : '&');
    const extra = `${paramDelim}cli_browser_id=${this.def.id}`;
    return this.url + extra;
  }

  private _resolve: () => void;
  private _reject: (err: any) => void;

  /**
   * @param emitter The emitter to send updates about test progress to.
   * @param def A BrowserDef describing and defining the browser to be run.
   *     Includes both metadata and a method for connecting/launching the
   *     browser.
   * @param options WCT options.
   * @param url The url of the generated index.html file that the browser should
   *     point at.
   * @param waitFor Optional. If given, we won't try to start/connect to the
   *     browser until this promise resolves. Used for serializing access to
   *     Safari webdriver, which can only have one instance running at once.
   */
  constructor(
    emitter: NodeJS.EventEmitter, def: BrowserDef, options: Config,
    url: string, waitFor?: Promise<void>) {
    this.emitter = emitter;
    this.def = def;
    this.options = options;
    this.timeout = options.testTimeout;
    this.emitter = emitter;
    this.url = url;

    this.stats = { status: 'initializing' };

    this.donePromise = new Promise<void>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });

    waitFor = waitFor || Promise.resolve();
    waitFor.then(() => {
      cleankill.onInterrupt((done) => {
        if (!this.isBrowserRunning()) {
          return done();
        }

        this.donePromise.then(() => done(), () => done());
        this.done('Interrupting');
      });

      this.initBrowser();
      this.emitter.emit('browser-init', this.def, this.stats);
      this.attachBrowser().then(() => {
        this.emitter.emit('browser-attach', this.def, this.stats);
        this.extendTimeout();
      }).catch(error => {
        this.done(error);
      });
    });
  }

  onEvent(event: string, data: any) {
    this.extendTimeout();
    if (event === 'browser-start') {
      // Always assign, to handle re-runs (no browser-init).
      this.stats = {
        status: 'running',
        passing: 0,
        pending: 0,
        failing: 0,
      };
    } else if (event === 'test-end') {
      this.stats[data.state] = this.stats[data.state] + 1;
    }

    if (event === 'browser-end' || event === 'browser-fail') {
      this.done(data);
    } else {
      this.emitter.emit(event, this.def, data, this.stats);
    }
  }

  done(error: any) {
    // No quitting for you!
    if (this.options.persistent) {
      return;
    }

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    // Don't double-quit.
    if (!this.isBrowserRunning()) {
      return;
    }

    this.quitBrowser().then(() => {
      error ? this._reject(error) : this._resolve();
    }).catch(quitError => {
      if (quitError) {
        this.emitter.emit(
          'log:warn', this.def,
          'Failed to quit:', quitError.data || quitError);
      }
      if (error) {
        this._reject(error);
      } else {
        this._resolve();
      }
    });

    this.stats.status = error ? 'error' : 'complete';
    if (!error && this.stats.failing > 0) {
      error = this.stats.failing + ' failed tests';
    }

    this.emitter.emit('browser-end', this.def, error, this.stats);
  }

  extendTimeout() {
    if (this.options.persistent) {
      return;
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    this.timeoutId = setTimeout(() => {
      this.done('Timed out');
    }, this.timeout);
  }

  quit() {
    this.done('quit was called');
  }

  protected abstract initBrowser(): void;
  protected abstract attachBrowser(): Promise<void>;
  protected abstract isBrowserRunning(): boolean;
  protected abstract quitBrowser(): Promise<void>;
}
