import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import * as RA from 'fp-ts/ReadonlyArray';
import * as RR from 'fp-ts/ReadonlyRecord';
import * as TE from 'fp-ts/TaskEither';
import { flow, identity, pipe } from 'fp-ts/lib/function';
import { Service } from 'homebridge';
import { SupportedActionsType } from '../domain/alexa';
import { AirQualityMonitorState } from '../domain/alexa/air-quality-monitor';
import { CarbonMonoxideRangeFeatures } from '../domain/alexa/carbon-monoxide-sensor';
import { RangeFeature } from '../domain/alexa/save-device-capabilities';
import * as mapper from '../mapper/air-quality-mapper';
import BaseAccessory from './base-accessory';

export default class CarbonMonoxideAccessory extends BaseAccessory {
  static requiredOperations: SupportedActionsType[] = [];
  service: Service;
  isExternalAccessory = false;
  private lastErrorTime: { [key: string]: number } = {};
  private readonly ERROR_COOLDOWN = 30000; // 30 seconds

  configureServices() {
    this.service =
      this.platformAcc.getService(this.Service.CarbonMonoxideSensor) ||
      this.platformAcc.addService(
        this.Service.CarbonMonoxideSensor,
        this.device.displayName,
      );

    pipe(
      CarbonMonoxideRangeFeatures,
      RA.findFirstMap((a) => RR.lookup(a)(this.rangeFeatures)),
      O.match(
        () =>
          this.logWithContext(
            'error',
            `Carbon monoxide sensor was not created for ${this.device.displayName}`,
          ),
        (asset) => {
          this.service
            .getCharacteristic(this.Characteristic.CarbonMonoxideDetected)
            .onGet(this.handleCarbonMonoxideDetectedGet.bind(this, asset));
          this.service
            .getCharacteristic(this.Characteristic.CarbonMonoxideLevel)
            .onGet(this.handleCarbonMonoxideLevelGet.bind(this, asset));
        },
      ),
    );
  }

  async handleCarbonMonoxideDetectedGet(asset: RangeFeature): Promise<number> {
    const cachedValue = this.getCacheValue('range', undefined, asset.instance);
    if (O.isSome(cachedValue)) {
      const mappedValue = mapper.mapAlexaCoLevelToHomeKitDetected(
        cachedValue.value,
        this.Characteristic.CarbonMonoxideDetected,
      );
      this.logWithContext(
        'debug',
        `Using cached carbon monoxide detected value: ${mappedValue}`,
      );
      return mappedValue;
    }

    if (this.shouldSkipApiCall('CarbonMonoxideDetected')) {
      this.logWithContext(
        'debug',
        'Skipping carbon monoxide detected API call due to recent error',
      );
      throw this.serviceCommunicationError;
    }

    const determineCoDetected = flow(
      A.findFirst<AirQualityMonitorState>(
        ({ featureName, instance }) =>
          featureName === 'range' && asset.instance === instance,
      ),
      O.map(({ value }) =>
        mapper.mapAlexaCoLevelToHomeKitDetected(
          value,
          this.Characteristic.CarbonMonoxideDetected,
        ),
      ),
      O.tap((s) =>
        O.of(
          this.logWithContext(
            'debug',
            `Get carbon monoxide detected result: ${s}`,
          ),
        ),
      ),
    );

    return pipe(
      this.getStateGraphQl(determineCoDetected),
      TE.match((e) => {
        this.recordError('CarbonMonoxideDetected');

        const fallbackValue = this.getCacheValue(
          'range',
          undefined,
          asset.instance,
        );
        if (O.isSome(fallbackValue)) {
          const mappedValue = mapper.mapAlexaCoLevelToHomeKitDetected(
            fallbackValue.value,
            this.Characteristic.CarbonMonoxideDetected,
          );
          this.logWithContext(
            'warn',
            `Carbon monoxide detected data unavailable for ${this.device.displayName}, using fallback cached value: ${mappedValue}. Error: ${e.message}`,
          );
          return mappedValue;
        }

        this.logWithContext('errorT', 'Get carbon monoxide detected', e);
        throw this.serviceCommunicationError;
      }, identity),
    )();
  }

  async handleCarbonMonoxideLevelGet(asset: RangeFeature): Promise<number> {
    const cachedValue = this.getCacheValue('range', undefined, asset.instance);
    if (O.isSome(cachedValue) && typeof cachedValue.value === 'number') {
      this.logWithContext(
        'debug',
        `Using cached carbon monoxide level value: ${cachedValue.value}`,
      );
      return cachedValue.value;
    }

    if (this.shouldSkipApiCall('CarbonMonoxideLevel')) {
      this.logWithContext(
        'debug',
        'Skipping carbon monoxide level API call due to recent error',
      );
      throw this.serviceCommunicationError;
    }

    return pipe(
      this.getStateGraphQl(this.determineLevel(asset)),
      TE.match((e) => {
        this.recordError('CarbonMonoxideLevel');

        const fallbackValue = this.getCacheValue(
          'range',
          undefined,
          asset.instance,
        );
        if (
          O.isSome(fallbackValue) &&
          typeof fallbackValue.value === 'number'
        ) {
          this.logWithContext(
            'warn',
            `Carbon monoxide level data unavailable for ${this.device.displayName}, using fallback cached value: ${fallbackValue.value}. Error: ${e.message}`,
          );
          return fallbackValue.value;
        }

        this.logWithContext('errorT', 'Get carbon monoxide level', e);
        throw this.serviceCommunicationError;
      }, identity),
    )();
  }

  private shouldSkipApiCall(rangeName: string): boolean {
    const lastError = this.lastErrorTime[rangeName];
    return Boolean(lastError && Date.now() - lastError < this.ERROR_COOLDOWN);
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
      O.tap(({ value }) =>
        O.of(this.logWithContext('debug', `Get ${asset.rangeName}: ${value}`)),
      ),
      O.flatMap(({ value }) =>
        typeof value === 'number' ? O.of(value) : O.none,
      ),
    );
  }
}
