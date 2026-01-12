import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { PuraPlatformAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { Pura, PuraTokens, PuraAuthenticationError, PuraApiException } from './lib/purajs/index.js';
import { PuraDevice, PuraConfig } from './puraTypes.js';

/**
 * PuraPlatform
 * This class is the main constructor for the Pura plugin, this is where we
 * authenticate with Pura and discover/register accessories with Homebridge.
 */
export class PuraPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  private pura: Pura | null = null;
  private readonly puraConfig: PuraConfig;
  private refreshInterval: NodeJS.Timeout | null = null;
  private readonly tokenCachePath: string;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // Validate configuration
    if (!config.username || !config.password) {
      this.log.error('Username and password are required in the config');
      throw new Error('Username and password are required in the config');
    }

    this.puraConfig = config as PuraConfig;
    this.tokenCachePath = this.api.user.storagePath() + '/homebridge-pura-tokens.json';
    this.pura = null; // Will be initialized in discoverDevices()

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });

    // Clean up on shutdown
    this.api.on('shutdown', () => {
      if (this.refreshInterval) {
        clearInterval(this.refreshInterval);
      }
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Initialize Pura client with saved tokens or fresh authentication
   */
  private async initializePuraClient() {
    // Try to load saved tokens
    const savedTokens = await this.loadTokens();

    if (savedTokens) {
      this.log.info('Initializing Pura client with saved tokens...');
      this.pura = new Pura({
        username: this.puraConfig.username,
        ...savedTokens,
      });

      // Verify tokens are still valid by making a test request
      try {
        await this.pura.getDevices();
        this.log.info('Saved tokens are valid');
        return;
      } catch (error) {
        this.log.debug('Saved tokens are invalid, will re-authenticate');
        this.pura = null;
      }
    }

    // No valid tokens, authenticate with password
    this.log.info('Authenticating with Pura...');
    this.pura = new Pura({
      username: this.puraConfig.username,
    });

    await this.pura.authenticate(this.puraConfig.password);
    this.log.info('Pura authentication successful');
  }

  /**
   * Load tokens from cache file
   */
  private async loadTokens(): Promise<PuraTokens | null> {
    try {
      const fs = await import('fs/promises');
      const data = await fs.readFile(this.tokenCachePath, 'utf-8');
      const tokens = JSON.parse(data) as PuraTokens;
      this.log.debug('Loaded tokens from cache');
      return tokens;
    } catch (error) {
      this.log.debug('No cached tokens found or error reading cache');
      return null;
    }
  }

  /**
   * Save tokens to cache file
   */
  private async saveTokens() {
    if (!this.pura) {
      return;
    }

    try {
      const tokens = await this.pura.getTokens();
      if (tokens.accessToken && tokens.idToken && tokens.refreshToken) {
        const fs = await import('fs/promises');
        const data = JSON.stringify(tokens, null, 2);
        await fs.writeFile(this.tokenCachePath, data, 'utf-8');
        this.log.debug('Saved tokens to cache');
      }
    } catch (error) {
      this.log.error('Failed to save tokens:', error);
    }
  }

  /**
   * Discover and register Pura devices
   */
  async discoverDevices() {
    try {
      // Initialize Pura client
      await this.initializePuraClient();

      if (!this.pura) {
        throw new Error('Failed to initialize Pura client');
      }

      // Get devices
      this.log.info('Discovering Pura devices...');
      const response = await this.pura.getDevices();
      const devices = response.devices || [];
      this.log.info(`Found ${devices.length} Pura device(s)`);

      // Save tokens after successful authentication
      await this.saveTokens();

      // Register each device
      for (const device of devices) {
        await this.registerDevice(device);
      }

      // Remove accessories that are no longer present
      this.removeStaleAccessories();

      // Set up refresh interval
      this.setupRefreshInterval();

    } catch (error) {
      if (error instanceof PuraAuthenticationError) {
        this.log.error('Pura authentication failed:', error.message);
        this.log.error('Please check your username and password in the config');
      } else {
        this.log.error('Failed to discover Pura devices:', error);
      }
    }
  }

  /**
   * Register a Pura device as a HomeKit accessory
   */
  private async registerDevice(device: PuraDevice) {
    this.log.debug('Registering device:', device.name, device.id);

    // Create accessory for each bay that exists
    if (device.bay1) {
      await this.registerBayAccessory(device, 1);
    }
    if (device.bay2) {
      await this.registerBayAccessory(device, 2);
    }
  }

  /**
   * Register a bay as a separate accessory
   */
  private async registerBayAccessory(device: PuraDevice, bayNumber: number) {
    const bay = bayNumber === 1 ? device.bay1 : device.bay2;
    if (!bay) {
      return;
    }

    const accessoryName = `${device.name} Bay ${bayNumber}`;
    const uniqueId = `${device.id}-bay${bayNumber}`;
    const uuid = this.api.hap.uuid.generate(uniqueId);

    // Check if accessory already exists
    const existingAccessory = this.accessories.get(uuid);

    if (existingAccessory) {
      // Update existing accessory
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      existingAccessory.context.device = device;
      existingAccessory.context.bayNumber = bayNumber;
      this.api.updatePlatformAccessories([existingAccessory]);

      // Create the accessory handler
      new PuraPlatformAccessory(this, existingAccessory, this.pura!);
    } else {
      // Create new accessory
      this.log.info('Adding new accessory:', accessoryName);
      const accessory = new this.api.platformAccessory(accessoryName, uuid);

      // Store device info in context
      accessory.context.device = device;
      accessory.context.bayNumber = bayNumber;

      // Create the accessory handler
      new PuraPlatformAccessory(this, accessory, this.pura!);

      // Register the accessory
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    // Track this UUID as discovered
    this.discoveredCacheUUIDs.push(uuid);
  }

  /**
   * Remove accessories that are no longer present
   */
  private removeStaleAccessories() {
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  /**
   * Set up periodic refresh of device status
   */
  private setupRefreshInterval() {
    const interval = (this.puraConfig.refreshInterval || 300) * 1000; // Convert to milliseconds
    this.log.debug(`Setting up refresh interval: ${interval / 1000} seconds`);

    this.refreshInterval = setInterval(async () => {
      try {
        this.log.debug('Refreshing device status...');
        await this.refreshDeviceStatus();
      } catch (error) {
        this.log.error('Failed to refresh device status:', error);
      }
    }, interval);
  }

  /**
   * Refresh status of all devices
   */
  private async refreshDeviceStatus() {
    if (!this.pura) {
      this.log.error('Pura client not initialized');
      return;
    }

    try {
      const response = await this.pura.getDevices();
      const devices = response.devices || [];

      for (const device of devices) {
        // Update accessories for each bay
        if (device.bay1) {
          await this.updateBayAccessory(device, 1);
        }
        if (device.bay2) {
          await this.updateBayAccessory(device, 2);
        }
      }
    } catch (error) {
      if (error instanceof PuraAuthenticationError) {
        this.log.error('Authentication error during refresh:', error.message);
        this.log.error('Please restart Homebridge to re-authenticate');
      } else {
        this.log.debug('Device status refresh failed:', error);
      }
    }
  }

  /**
   * Update a bay accessory with fresh device data
   */
  private async updateBayAccessory(device: PuraDevice, bayNumber: number) {
    const uniqueId = `${device.id}-bay${bayNumber}`;
    const uuid = this.api.hap.uuid.generate(uniqueId);
    const accessory = this.accessories.get(uuid);

    if (accessory) {
      accessory.context.device = device;
      this.api.updatePlatformAccessories([accessory]);
    }
  }
}
