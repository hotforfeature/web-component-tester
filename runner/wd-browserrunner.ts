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

import * as chalk from 'chalk';
import * as _ from 'lodash';
import * as wd from 'wd';
import { BrowserDef, BrowserRunner } from './browserrunner';
import { Config } from './config';

// Browser abstraction, responsible for spinning up a browser instance via wd.js
// and executing runner.html test files passed in options.files
export class WdBrowserRunner extends BrowserRunner<wd.Browser> {
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
    super(emitter, def, options, url, waitFor);
  }

  protected initBrowser(): void {
    this.browser = wd.remote(this.def.url);

    // never retry selenium commands
    this.browser.configureHttp({ retries: -1 });

    this.browser.on('command', (method: any, context: any) => {
      this.emitter.emit('log:debug', this.def, chalk.cyan(method), context);
    });

    this.browser.on('http', (method: any, path: any, data: any) => {
      if (data) {
        this.emitter.emit(
          'log:debug', this.def, chalk.magenta(method), chalk.cyan(path),
          data);
      } else {
        this.emitter.emit(
          'log:debug', this.def, chalk.magenta(method), chalk.cyan(path));
      }
    });

    this.browser.on('connection', (code: any, message: any, error: any) => {
      this.emitter.emit(
        'log:warn', this.def, 'Error code ' + code + ':', message, error);
    });
  }

  protected attachBrowser(): Promise<void> {
    return new Promise((resolve) => {
      // Make sure that we are passing a pristine capabilities object to
      // webdriver. None of our screwy custom properties!
      const webdriverCapabilities = _.clone(this.def);
      delete webdriverCapabilities.id;
      delete webdriverCapabilities.url;
      delete webdriverCapabilities.sessionId;

      // Reusing a session?
      if (this.def.sessionId) {
        this.browser.attach(this.def.sessionId, (error) => {
          resolve({
            error,
            sessionId: this.def.sessionId
          });
        });
      } else {
        this.browser.init(webdriverCapabilities, (error, sessionId) => {
          resolve({
            error,
            sessionId
          });
        });
      }
    }).then(({ error, sessionId }) => {
      return new Promise<void>((resolve, reject) => {
        if (!this.isBrowserRunning()) {
          return resolve();  // When interrupted.
        }
        if (error) {
          // TODO(nevir): BEGIN TEMPORARY CHECK.
          // https://github.com/Polymer/web-component-tester/issues/51
          if (this.def.browserName === 'safari' && error.data) {
            // debugger;
            try {
              const data = JSON.parse(error.data);
              if (data.value && data.value.message &&
                /Failed to connect to SafariDriver/i.test(data.value.message)) {
                error = 'Until Selenium\'s SafariDriver supports ' +
                  'Safari 6.2+, 7.1+, & 8.0+, you must\n' +
                  'manually install it. Follow the steps at:\n' +
                  'https://github.com/SeleniumHQ/selenium/' +
                  'wiki/SafariDriver#getting-started';
              }
            } catch (error) {
              // Show the original error.
            }
          }
          // END TEMPORARY CHECK
          reject(error.data || error);
        } else {
          this.extendTimeout();
          this.sessionId = sessionId;
          this.browser.get(this.testUrl, (error) => {
            if (error) {
              reject(error.data || error);
            } else {
              resolve();
            }
          });
        }
      });
    });
  }

  protected quitBrowser(browser: wd.Browser): Promise<void> {
    // Nothing to quit.
    if (!this.sessionId) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      browser.quit((quitError) => {
        if (quitError) {
          reject(quitError);
        } else {
          resolve();
        }
      });
    });
  }
}
