/**
 * Pura account.
 */

import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import axios, { AxiosInstance, AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';
import { CLIENT_ID, USER_POOL_ID } from './const';
import { PuraApiException, PuraAuthenticationError } from './exceptions';
import { decode } from './utils';
import { WebSocketSubscriber, MessageHandler } from './ws_subscriber';

export const BASE_URL = 'https://trypura.io/mobile/api/';
export const TIMER_DURATION_DEFAULT = 4 * 60 * 60; // 4 hours in seconds

export interface PuraTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
}

export interface PuraConfig {
  username?: string;
  accessToken?: string;
  idToken?: string;
  refreshToken?: string;
}

/**
 * Pura account class for managing Pura smart fragrance diffusers.
 */
export class Pura {
  private username?: string;
  private _accessToken?: string;
  private _idToken?: string;
  private _refreshToken?: string;
  private userPool: CognitoUserPool;
  private cognitoUser?: CognitoUser;
  private httpClient: AxiosInstance;

  constructor(config: PuraConfig = {}) {
    this.username = config.username;
    this._accessToken = config.accessToken;
    this._idToken = config.idToken;
    this._refreshToken = config.refreshToken;

    this.userPool = new CognitoUserPool({
      UserPoolId: decode(USER_POOL_ID),
      ClientId: decode(CLIENT_ID),
    });

    this.httpClient = axios.create({
      baseURL: BASE_URL,
      timeout: 10000,
    });

    // Add request interceptor to include auth token
    this.httpClient.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
      const tokens = await this.getTokens();
      if (tokens.idToken) {
        config.headers.Authorization = `Bearer ${tokens.idToken}`;
      }
      return config;
    });
  }

  /**
   * Get the Cognito user.
   */
  private getCognitoUser(): CognitoUser {
    if (!this.cognitoUser) {
      if (!this.username) {
        throw new PuraAuthenticationError('Username is required');
      }

      this.cognitoUser = new CognitoUser({
        Username: this.username,
        Pool: this.userPool,
      });

      // If we have tokens, set them on the user
      if (this._accessToken && this._idToken && this._refreshToken) {
        const session = new CognitoUserSession({
          IdToken: this._idToken as any,
          AccessToken: this._accessToken as any,
          RefreshToken: this._refreshToken as any,
        });
        this.cognitoUser.setSignInUserSession(session);
      }
    }
    return this.cognitoUser;
  }

  /**
   * Get authentication tokens.
   */
  async getTokens(): Promise<Partial<PuraTokens>> {
    return new Promise((resolve, reject) => {
      const user = this.getCognitoUser();
      const session = user.getSignInUserSession();

      if (session && session.isValid()) {
        resolve({
          accessToken: session.getAccessToken().getJwtToken(),
          idToken: session.getIdToken().getJwtToken(),
          refreshToken: session.getRefreshToken().getToken(),
        });
      } else if (this._refreshToken) {
        // Try to refresh the session
        user.refreshSession(
          { getToken: () => this._refreshToken! } as any,
          (err, session) => {
            if (err) {
              reject(new PuraAuthenticationError(err.message));
            } else {
              this._accessToken = session.getAccessToken().getJwtToken();
              this._idToken = session.getIdToken().getJwtToken();
              this._refreshToken = session.getRefreshToken().getToken();
              resolve({
                accessToken: this._accessToken,
                idToken: this._idToken,
                refreshToken: this._refreshToken,
              });
            }
          }
        );
      } else {
        resolve({});
      }
    });
  }

  /**
   * Authenticate a user with username and password.
   */
  async authenticate(password: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.username) {
        reject(new PuraAuthenticationError('Username is required'));
        return;
      }

      const authDetails = new AuthenticationDetails({
        Username: this.username,
        Password: password,
      });

      const user = this.getCognitoUser();

      user.authenticateUser(authDetails, {
        onSuccess: (session) => {
          this._accessToken = session.getAccessToken().getJwtToken();
          this._idToken = session.getIdToken().getJwtToken();
          this._refreshToken = session.getRefreshToken().getToken();
          resolve();
        },
        onFailure: (err) => {
          reject(new PuraAuthenticationError(err.message));
        },
      });
    });
  }

  /**
   * Logout of all clients (including app).
   */
  async logout(): Promise<void> {
    return new Promise((resolve, reject) => {
      const user = this.getCognitoUser();
      user.globalSignOut({
        onSuccess: () => {
          this._accessToken = undefined;
          this._idToken = undefined;
          this._refreshToken = undefined;
          resolve();
        },
        onFailure: (err) => {
          reject(new PuraApiException(err.message));
        },
      });
    });
  }

  /**
   * Get all devices.
   */
  async getDevices(): Promise<any> {
    return this.get('v2/users/devices');
  }

  /**
   * Get latest firmware details.
   */
  async getLatestFirmwareDetails(
    deviceType: string,
    deviceVersion: string
  ): Promise<string> {
    const response = await this.httpClient.get(
      'https://prod.api.purascents.com/api/firmware/config',
      {
        headers: {
          'pura-device-type': deviceType,
          'pura-device-version': deviceVersion,
        },
      }
    );
    return response.data;
  }

  /**
   * Set always on mode for a bay.
   */
  async setAlwaysOn(deviceId: string, bay: number): Promise<boolean> {
    const resp = await this.post(`devices/${deviceId}/always-on`, {
      bay,
    });
    return resp.success === true;
  }

  /**
   * Set ambient mode.
   */
  async setAmbientMode(deviceId: string, ambientMode: boolean): Promise<boolean> {
    const resp = await this.post(`devices/${deviceId}/ambientMode`, {
      ambientMode,
    });
    return resp.success === true;
  }

  /**
   * Set away mode with optional geofencing.
   */
  async setAwayMode(
    deviceId: string,
    awayMode: boolean,
    latitude?: number,
    longitude?: number,
    radius?: number
  ): Promise<boolean> {
    const json: any = { awayMode };
    if (awayMode) {
      json.latitude = latitude;
      json.longitude = longitude;
      json.radius = radius;
    }
    const resp = await this.post(`devices/${deviceId}/awayMode`, json);
    return resp.success === true;
  }

  /**
   * Set diffusion mode.
   */
  async setDiffusionMode(deviceId: string, mode: string): Promise<boolean> {
    const resp = await this.post(`v3/diffusion/${deviceId}/mode`, {
      mode,
    });
    return resp.success === true;
  }

  /**
   * Set fragrance intensity.
   */
  async setIntensity(
    deviceId: string,
    bay: number,
    controller: string,
    intensity: number
  ): Promise<boolean> {
    const resp = await this.post(`devices/${deviceId}/intensity`, {
      bay,
      controller,
      intensity,
    });
    return resp.success === true;
  }

  /**
   * Set nightlight settings.
   */
  async setNightlight(
    deviceId: string,
    active: boolean,
    brightness: number,
    color: string,
    controller: string
  ): Promise<boolean> {
    const resp = await this.post(`devices/${deviceId}/nightlight`, {
      active,
      brightness,
      color,
      controller,
    });
    return resp.success === true;
  }

  /**
   * Set timer for diffusion.
   */
  async setTimer(
    deviceId: string,
    bay: number,
    intensity: number,
    start?: Date | number,
    end: Date | number = TIMER_DURATION_DEFAULT
  ): Promise<boolean> {
    let startTime: number;
    let endTime: number;

    // Handle start time
    if (!start) {
      startTime = Math.floor(Date.now() / 1000);
    } else if (start instanceof Date) {
      startTime = Math.floor(start.getTime() / 1000);
    } else {
      startTime = start;
    }

    // Handle end time
    if (end instanceof Date) {
      endTime = Math.floor(end.getTime() / 1000);
    } else if (typeof end === 'number') {
      // If end is a number less than a year in seconds, treat it as duration
      if (end < 31536000) {
        endTime = startTime + end;
      } else {
        endTime = end;
      }
    } else {
      endTime = startTime + TIMER_DURATION_DEFAULT;
    }

    if (endTime <= startTime) {
      throw new PuraApiException("Timer 'end' time must be greater than 'start' time");
    }

    const resp = await this.post(`devices/${deviceId}/timer`, {
      bay,
      intensity,
      start: startTime,
      end: endTime,
      validateOverride: true,
    });
    return resp.success === true;
  }

  /**
   * Stop all diffusion on a device.
   */
  async stopAll(deviceId: string): Promise<boolean> {
    const resp = await this.post(`devices/${deviceId}/stop-all`, {});
    return resp.success === true;
  }

  /**
   * Subscribe for real-time device updates via WebSocket.
   */
  async subscribeForUpdates(onMessage: MessageHandler): Promise<WebSocketSubscriber> {
    const tokens = await this.getTokens();
    if (!tokens.idToken) {
      throw new PuraAuthenticationError('Unauthenticated');
    }

    const subscriber = new WebSocketSubscriber(tokens.idToken);
    subscriber.start(onMessage);
    return subscriber;
  }

  /**
   * Make a GET request.
   */
  private async get(url: string, config?: AxiosRequestConfig): Promise<any> {
    try {
      const response = await this.httpClient.get(url, config);
      return response.data;
    } catch (error: any) {
      if (error.response) {
        console.error(`Status: ${error.response.status} - ${error.response.data}`);
      }
      throw new PuraApiException(error.message);
    }
  }

  /**
   * Make a POST request.
   */
  private async post(url: string, data?: any, config?: AxiosRequestConfig): Promise<any> {
    try {
      const response = await this.httpClient.post(url, data, config);
      return response.data;
    } catch (error: any) {
      if (error.response) {
        console.error(`Status: ${error.response.status} - ${error.response.data}`);
      }
      throw new PuraApiException(error.message);
    }
  }
}
