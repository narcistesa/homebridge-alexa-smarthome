import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { flow, identity, pipe } from 'fp-ts/lib/function';
import { Service } from 'homebridge';
import { SupportedActionsType } from '../domain/alexa';
import { TempSensorState } from '../domain/alexa/temperature-sensor';
import * as tempMapper from '../mapper/temperature-mapper';
import BaseAccessory from './base-accessory';

export default class TemperatureAccessory extends BaseAccessory {
  static requiredOperations: SupportedActionsType[] = [];
  service: Service;
  isExternalAccessory = false;

  configureServices() {
    this.service =
      this.platformAcc.getService(this.Service.TemperatureSensor) ||
      this.platformAcc.addService(
        this.Service.TemperatureSensor,
        this.device.displayName,
      );

    this.service
      .getCharacteristic(this.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTempGet.bind(this));
  }

  async handleCurrentTempGet(): Promise<number> {
    const determineCurrentTemp = flow(
      A.findFirst<TempSensorState>(
        ({ featureName }) => featureName === 'temperatureSensor',
      ),
      O.flatMap(({ value }) => tempMapper.mapAlexaTempToHomeKit(value)),
      O.tap((s) =>
        O.of(
          this.logWithContext(
            'debug',
            `Get current temperature result: ${s} Celsius`,
          ),
        ),
      ),
    );

    return pipe(
      this.getStateGraphQl(determineCurrentTemp),
      TE.match((e) => {
        this.logWithContext(
          'warn',
          `Temperature data unavailable for ${this.device.displayName}, using fallback value. Error: ${e.message}`,
        );

        const cachedValue = this.getCacheValue('temperatureSensor');
        if (O.isSome(cachedValue)) {
          const mappedTemp = tempMapper.mapAlexaTempToHomeKit(cachedValue.value);
          if (O.isSome(mappedTemp)) {
            this.logWithContext(
              'debug',
              `Using cached temperature value: ${mappedTemp.value} Celsius`,
            );
            return mappedTemp.value;
          }
        }

        this.logWithContext(
          'debug',
          'No cached temperature value available, returning 0 Celsius',
        );
        return 0;
      }, identity),
    )();
  }
}
