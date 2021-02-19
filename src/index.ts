import { Config, Delta, NtpDelta, NtpHistory, NtpServer } from "./types";

import { NtpClientError } from "./error";
import { getNetworkTime } from "./client";

export default class NTPSync {
  private ntpServers: Array<NtpServer>;
  private limit: number;
  private tickRate: number;
  private syncTimeout: number;
  private currentIndex = 0;
  private tickId = null;
  private historyDetails: NtpHistory;

  public constructor({
    servers = [
      { server: "time.google.com", port: 123 },
      { server: "time.cloudflare.com", port: 123 },
      { server: "0.pool.ntp.org", port: 123 },
      { server: "1.pool.ntp.org", port: 123 },
    ],
    history = 10,
    syncInterval = 300 * 1000,
    syncTimeout = 10 * 1000,
    syncOnCreation = true,
    autoSync = true,
  }: Config = {}) {
    this.ntpServers = servers;
    this.limit = history;
    this.tickRate = syncInterval;
    this.syncTimeout = syncTimeout;
    this.historyDetails = {
      currentConsecutiveErrorCount: 0,
      currentServer: this.ntpServers[this.currentIndex],
      deltas: [],
      errors: [],
      isInErrorState: false,
      lastSyncTime: null,
      lastNtpTime: null,
      lastError: null,
      lifetimeErrorCount: 0,
      maxConsecutiveErrorCount: 0,
    };

    if (syncOnCreation) {
      this.syncTime();
    }

    if (autoSync) {
      this.startTick();
    }
  }

  private computeAndUpdate = (ntpDate: Date): number => {
    const tempServerTime = ntpDate.getTime();
    const tempLocalTime = Date.now();
    const dt = tempServerTime - tempLocalTime;
    if (this.historyDetails.deltas.length === this.limit) {
      this.historyDetails.deltas.shift();
    }
    this.historyDetails.deltas.push({
      dt: dt,
      ntp: tempServerTime,
    });
    this.historyDetails.lastSyncTime = tempLocalTime;
    this.historyDetails.lastNtpTime = tempServerTime;
    return dt;
  };

  public getDelta = async (): Promise<NtpDelta> => {
    const fetchingServer = Object.assign({}, this.historyDetails.currentServer);

    try {
      const ntpDate = await getNetworkTime(
        this.historyDetails.currentServer.server,
        this.historyDetails.currentServer.port,
        this.syncTimeout
      );
      const delta = this.computeAndUpdate(ntpDate);

      return {
        delta,
        fetchingServer,
      };
    } catch (err) {
      this.shiftServer();
      throw new NtpClientError(err, fetchingServer);
    }
  };

  public getHistory = (): NtpHistory => {
    return JSON.parse(JSON.stringify(this.historyDetails)) as NtpHistory;
  };

  public getTime = () => {
    let sum = this.historyDetails.deltas.reduce((a, b) => {
      return a + b.dt;
    }, 0);
    let avg = Math.round(sum / this.historyDetails.deltas.length) || 0;
    return Date.now() + avg;
  };

  private shiftServer = () => {
    if (this.ntpServers.length > 1) {
      this.currentIndex++;
      this.currentIndex %= this.ntpServers.length;
    }
    this.historyDetails.currentServer = this.ntpServers[this.currentIndex];
  };

  private startTick = () => {
    if (!this.tickId) {
      this.tickId = setInterval(() => this.syncTime(), this.tickRate);
    }
  };

  public syncTime = async (): Promise<boolean> => {
    try {
      const delta = await this.getDelta();

      this.historyDetails.currentConsecutiveErrorCount = 0;
      this.historyDetails.isInErrorState = false;
      return true;
    } catch (err) {
      var ed = {
        name: err.name,
        message: err.message,
        server: err.server,
        stack: err.stack,
        time: Date.now(),
      };
      this.historyDetails.currentConsecutiveErrorCount++;
      if (this.historyDetails.errors.length === this.limit) {
        this.historyDetails.errors.shift();
      }
      this.historyDetails.errors.push(ed);
      this.historyDetails.isInErrorState = true;
      this.historyDetails.lastError = ed;
      this.historyDetails.lifetimeErrorCount++;
      this.historyDetails.maxConsecutiveErrorCount = Math.max(
        this.historyDetails.maxConsecutiveErrorCount,
        this.historyDetails.currentConsecutiveErrorCount
      );
    }
    return false;
  };
}

export { Config, Delta, NtpDelta, NtpHistory, NtpServer, NtpClientError };
