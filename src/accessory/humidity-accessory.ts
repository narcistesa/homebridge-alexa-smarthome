import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import * as RA from 'fp-ts/ReadonlyArray';
import * as RR from 'fp-ts/ReadonlyRecord';
import * as TE from 'fp-ts/TaskEither';
import { flow, identity, pipe } from 'fp-ts/lib/function';
import { Service } from 'homebridge';
import { SupportedActionsType } from '../domain/alexa';
import { AirQualityMonitorState } from '../domain/alexa/air-quality-monitor';
import { HumiditySensorRangeFeatures } from '../domain/alexa/humidity-sensor';
import { RangeFeature } from '../domain/alexa/save-device-capabilities';
import BaseAccessory from './base-accessory';

export default class HumidityAccessory extends BaseAccessory {
  static requiredOperations: SupportedActionsType[] = [];
  service: Service;
  isExternalAccessory = false;
  private lastErrorTime: { [key: string]: number } = {};
  private readonly ERROR_COOLDOWN = 30000; // 30 seconds

  configureServices() {
    this.service =
      this.platformAcc.getService(this.Service.HumiditySensor) ||
      this.platformAcc.addService(
        this.Service.HumiditySensor,
        this.device.displayName,
      );

    pipe(
      HumiditySensorRangeFeatures,
      RA.findFirstMap((a) => RR.lookup(a)(this.rangeFeatures)),
      O.match(
        () =>
          this.logWithContext(
            'error',
            `Humidity sensor was not created for ${this.device.displayName}`,
          ),
        (asset) => {
          this.service
            .getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
            .onGet(this.handleHumidityGet.bind(this, asset));
        },
      ),
    );
  }

  async handleHumidityGet(asset: RangeFeature): Promise<number> {
    const cachedValue = this.getCacheValue('range', undefined, asset.instance);
    if (O.isSome(cachedValue) && typeof cachedValue.value === 'number') {
      this.logWithContext(
        'debug',
        `Using cached humidity value: ${cachedValue.value}`,
      );
      return cachedValue.value;
    }

    if (this.shouldSkipApiCall('Humidity')) {
      this.logWithContext(
        'debug',
        'Skipping humidity API call due to recent error',
      );
      throw this.serviceCommunicationError;
    }

    return pipe(
      this.getStateGraphQl(this.determineLevel(asset)),
      TE.match((e) => {
        this.recordError('Humidity');

        const fallbackValue = this.getCacheValue('range', undefined, asset.instance);
        if (O.isSome(fallbackValue) && typeof fallbackValue.value === 'number') {
          this.logWithContext(
            'warn',
            `Humidity data unavailable for ${this.device.displayName}, using fallback cached value: ${fallbackValue.value}. Error: ${e.message}`,
          );
          return fallbackValue.value;
        }

        this.logWithContext('errorT', 'Get humidity', e);
        throw this.serviceCommunicationError;
      }, identity),
    )();
  }

  private shouldSkipApiCall(rangeName: string): boolean {
    const lastError = this.lastErrorTime[rangeName];
    return Boolean(lastError && (Date.now() - lastError) < this.ERROR_COOLDOWN);
  }

  private recordError(rangeName: string): void {
    this.lastErrorTime[rangeName] = Date.now();
  }

  private determineLevel(asset: RangeFeature) {
    return flow(
      A.findFirst<AirQualityMonitorState>(
        ({ featureName, instance }) =>
          featureName === 'range' && asset.instance === instance,
      ),
      O.flatMap(({ value }) =>
        typeof value === 'number' ? O.of(value) : O.none,
      ),
      O.tap((s) =>
        O.of(this.logWithContext('debug', `Get ${asset.rangeName}: ${s}`)),
      ),
    );
  }
}
