import {
  API,
  APIEvent,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraControllerOptions,
  CharacteristicEventTypes,
  CharacteristicSetCallback,
  CharacteristicValue,
  DynamicPlatformPlugin,
  HAP,
  Logging,
  PlatformAccessory,
  PlatformAccessoryEvent,
  PlatformConfig,
} from 'homebridge';
import { NestCam, CameraInfo } from './nestcam';
import { NestEndpoints } from './nest-endpoints';
import { StreamingDelegate } from './streamingDelegate';
import { Connection } from './nest-connection';

let hap: HAP;
let Accessory: typeof PlatformAccessory;

const UPDATE_INTERVAL = 10000;
const PLUGIN_NAME = 'homebridge-nest-cam';
const PLATFORM_NAME = 'Nest-cam';

const modelTypes = [
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  'Nest Cam Indoor',
  'Nest Cam Outdoor',
  'Nest Cam IQ Indoor',
  'Nest Cam IQ Outdoor',
  'Nest Hello',
];

const setupConnection = async function (config: PlatformConfig, log: Logging): Promise<boolean> {
  if (!config.googleAuth) {
    log.error('You did not specify your Google account credentials, googleAuth, in config.json');
    return false;
  }

  if (config.googleAuth && (!config.googleAuth.issueToken || !config.googleAuth.cookies || !config.googleAuth.apiKey)) {
    log.error('You must provide issueToken, cookies and apiKey in config.json. Please see README.md for instructions');
    return false;
  }

  config.options.fieldTest = config.googleAuth.issueToken.includes('home.ft.nest.com');
  log.debug(`Setting Field Test to ${config.options.fieldTest}`);
  const conn = new Connection(config, log);
  return await conn.auth();
};

const setAlertInterval = async function (camera: NestCam, accessory: PlatformAccessory): Promise<void> {
  setInterval(async function () {
    camera.checkAlerts(accessory);
  }, UPDATE_INTERVAL);
};

const setSwitchInterval = async function (camera: NestCam, accessory: PlatformAccessory): Promise<void> {
  setInterval(async function () {
    await camera.updateInfo();
    const service = accessory.getService(hap.Service.Switch);
    if (service) {
      service.updateCharacteristic(hap.Characteristic.On, camera.enabled);
    }
  }, UPDATE_INTERVAL);
};

class NestCamPlatform implements DynamicPlatformPlugin {
  private readonly log: Logging;
  private readonly api: API;
  private config: PlatformConfig;
  private endpoints: NestEndpoints;
  private readonly accessories: Array<PlatformAccessory> = [];
  private motionDetection = true;
  private doorbellAlerts = true;
  private streamingSwitch = false;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.api = api;
    this.config = config;
    const fieldTest = config.googleAuth.issueToken.includes('home.ft.nest.com');
    this.endpoints = new NestEndpoints(fieldTest);

    // Need a config or plugin will not start
    if (!config) {
      return;
    }

    // Set up the config if options are not set
    const googleAuth = config['googleAuth'];
    const options = config['options'];
    if (typeof googleAuth === 'undefined') {
      throw new Error('googleAuth is not defined in the Homebridge config');
    }
    if (typeof options === 'undefined') {
      config.options = {};
    } else {
      const motionDetection = config.options['motionDetection'];
      if (typeof motionDetection !== 'undefined') {
        this.motionDetection = motionDetection;
      }
      const doorbellAlerts = config.options['doorbellAlerts'];
      if (typeof doorbellAlerts !== 'undefined') {
        this.doorbellAlerts = doorbellAlerts;
      }
      const streamingSwitch = config.options['streamingSwitch'];
      if (typeof streamingSwitch !== 'undefined') {
        this.streamingSwitch = streamingSwitch;
      }
      const disableAudio = config.options['disableAudio'];
      if (typeof disableAudio === 'undefined') {
        config.options.disableAudio = false;
      }
      const alertTypes = config.options['alertTypes'];
      if (typeof alertTypes === 'undefined') {
        config.options.alertTypes = ['motion'];
      }
    }

    api.on(APIEvent.DID_FINISH_LAUNCHING, this.didFinishLaunching.bind(this));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log(`Configuring accessory ${accessory.displayName}`);

    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log(`${accessory.displayName} identified!`);
    });

    const cameraInfo = accessory.context.cameraInfo;
    const camera = new NestCam(this.config, cameraInfo, this.log, hap);
    const streamingDelegate = new StreamingDelegate(hap, camera, this.config, this.log);
    const options: CameraControllerOptions = {
      cameraStreamCount: 2, // HomeKit requires at least 2 streams, but 1 is also just fine
      delegate: streamingDelegate,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [320, 180, 30],
            [320, 240, 15], // Apple Watch requires this configuration
            [320, 240, 30],
            [480, 270, 30],
            [480, 360, 30],
            [640, 360, 30],
            [640, 480, 30],
            [1280, 720, 30],
            [1280, 960, 30],
            [1920, 1080, 30],
            [1600, 1200, 30],
          ],
          codec: {
            profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
            levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
          },
        },
        audio: {
          codecs: [
            {
              type: AudioStreamingCodecType.AAC_ELD,
              samplerate: AudioStreamingSamplerate.KHZ_16,
            },
          ],
        },
      },
    };

    const cameraController = new hap.CameraController(options);
    streamingDelegate.controller = cameraController;

    accessory.configureController(cameraController);

    // Configure services
    const motion = accessory.getService('Motion');
    const doorbell = accessory.getService('Doorbell');
    const doorbellSwitch = accessory.getService('DoorbellSwitch');
    const enabledSwitch = accessory.getService('Streaming');

    // Motion configuration
    if (motion) {
      if (!this.motionDetection) {
        // Remove motion service
        accessory.removeService(motion);
      } else {
        // Check existing motion service
        setAlertInterval(camera, accessory);
      }
    } else {
      // Add motion service
      if (camera.detectors.includes('motion') && this.motionDetection) {
        const motion = new hap.Service.MotionSensor('Motion');
        accessory.addService(motion);
        setAlertInterval(camera, accessory);
      }
    }

    // Doorbell configuration
    if (doorbell) {
      if (!this.doorbellAlerts) {
        // Remove doorbell service
        accessory.removeService(doorbell);
      } else if (!this.motionDetection) {
        // Check existing doorbell service
        setAlertInterval(camera, accessory);
      }
    } else {
      // Add doorbell service
      if (camera.capabilities.includes('indoor_chime') && this.doorbellAlerts) {
        const doorbell = new hap.Service.Doorbell('Doorbell');
        accessory.addService(doorbell);
        if (!this.motionDetection) {
          setAlertInterval(camera, accessory);
        }
      }
    }

    // Add doorbell switch
    if (doorbellSwitch) {
      if (!this.doorbellAlerts) {
        // Remove doorbell service
        accessory.removeService(doorbellSwitch);
      }
    } else {
      if (camera.capabilities.includes('indoor_chime') && this.doorbellAlerts) {
        const doorbellSwitch = new hap.Service.StatelessProgrammableSwitch('DoorbellSwitch');
        doorbellSwitch.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent).setProps({
          maxValue: hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
        });

        accessory.addService(doorbellSwitch);
      }
    }

    // Streaming configuration
    if (enabledSwitch) {
      if (!this.streamingSwitch) {
        // Remove streaming service
        accessory.removeService(enabledSwitch);
      } else {
        // Check existing switch service
        enabledSwitch
          .setCharacteristic(hap.Characteristic.On, camera.enabled)
          .getCharacteristic(hap.Characteristic.On)
          .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
            await camera.toggleActive(value as boolean);
            this.log.info('Setting %s to %s', accessory.displayName, value ? 'on' : 'off');
            callback();
          });
        // Check enabled/disabled state
        setSwitchInterval(camera, accessory);
      }
    } else {
      // Add enabled/disabled service
      if (this.streamingSwitch) {
        accessory
          .addService(hap.Service.Switch, 'Streaming')
          .setCharacteristic(hap.Characteristic.On, camera.enabled)
          .getCharacteristic(hap.Characteristic.On)
          .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
            await camera.toggleActive(value as boolean);
            this.log.info('Setting %s to %s', accessory.displayName, value ? 'on' : 'off');
            callback();
          });
        // Check enabled/disabled state
        setSwitchInterval(camera, accessory);
      }
    }

    this.accessories.push(accessory);
  }

  /**
   * Add fetched cameras from nest to Homebridge
   */
  async addCameras(): Promise<void> {
    // Nest needs to be reauthenticated about every hour
    const config = this.config;
    const log = this.log;
    setInterval(async function () {
      await setupConnection(config, log);
    }, 3600000);

    try {
      const response = await this.endpoints.sendRequest(
        this.config.access_token,
        this.endpoints.CAMERA_API_HOSTNAME,
        '/api/cameras.get_owned_and_member_of_with_properties',
        'GET',
      );
      response.items.forEach((cameraInfo: CameraInfo) => {
        const uuid = hap.uuid.generate(cameraInfo.uuid);
        const accessory = new Accessory(cameraInfo.name, uuid);
        accessory.context.cameraInfo = cameraInfo;

        const model = cameraInfo.type < modelTypes.length ? modelTypes[cameraInfo.type] : 'Unknown';
        const accessoryInformation = accessory.getService(hap.Service.AccessoryInformation);
        if (accessoryInformation) {
          accessoryInformation.setCharacteristic(hap.Characteristic.Manufacturer, 'Nest');
          accessoryInformation.setCharacteristic(hap.Characteristic.Model, model);
          accessoryInformation.setCharacteristic(hap.Characteristic.SerialNumber, cameraInfo.serial_number);
          accessoryInformation.setCharacteristic(
            hap.Characteristic.FirmwareRevision,
            cameraInfo.combined_software_version,
          );
        }

        // Only add new cameras that are not cached
        if (!this.accessories.find((x: PlatformAccessory) => x.UUID === uuid)) {
          this.configureAccessory(accessory); // abusing the configureAccessory here
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      });

      // Remove cameras that were not in previous call
      this.accessories.forEach((accessory: PlatformAccessory) => {
        if (!response.items.find((x: CameraInfo) => x.uuid === accessory.context.cameraInfo.uuid)) {
          accessory.context.removed = true;
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      });
    } catch (error) {
      this.log.error('Error fetching cameras: ');
      this.log.error(error);
    }
  }

  async didFinishLaunching(): Promise<void> {
    const connected = await setupConnection(this.config, this.log);
    if (connected) {
      await this.addCameras();
    }
  }
}

export = (api: API): void => {
  hap = api.hap;
  Accessory = api.platformAccessory;

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, NestCamPlatform);
};
