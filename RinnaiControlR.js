const AylaApi = require('./rinnai/AylaApi.js');
const Rinnai = require('./rinnai/RinnaiConst.js');

const PLUGIN_NAME = 'homebridge-rinnai-control-r';
const PLATFORM_NAME = 'RinnaiControlR';
const REFRESH_TOKEN_INTERVAL = 3600000; // 1h

function fahrenheitToCelsius(v) {
    return Math.round((v - 32.0) * 5.0 / 9.0);
}
function celsiusToFahrenheit(v) {
    return Math.round(v * 9.0 / 5.0 + 32.0);
}

class RinnaiControlR {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        this.accessories = [];

        this.ayla_api = new AylaApi(this.log).on('error', err => {
            this.log.error(err);
        });

        api.on('didFinishLaunching', () => {
            this.ayla_api.getTokens(this.config.email, this.config.password, err => {
                if (err) {
                    this.log.error(err);
                    return;
                }
                this.ayla_api.getUUID((err, uuid) => {
                    if (err) {
                        this.log.error(err);
                        return;
                    }
                    this.ayla_api.getDevices(uuid, (err, devices) => {
                        if (err) {
                            this.log.error(err);
                            return;
                        }
                        this.unregisterAccessories(devices);
                        this.registerAccessories(devices);
                        this.token_refresher = setInterval(this.ayla_api.refreshToken.bind(this, err => {
                            if (err) { this.log.error(err); }
                        }), REFRESH_TOKEN_INTERVAL);
                    });
                })
            });
        });
    }

    static registerPlatform(api) {
        api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, this);
    }

    registerAccessories(devices) {
        devices.forEach(item => {
            const dsn = item.device.dsn;
            const name = item.device.product_name;
            const uuid = this.api.hap.uuid.generate(dsn);
            if (!this.accessories.find(accessory => accessory.UUID === uuid)) {
                this.log.info("Register new accessory:", name);
                const accessory = new this.api.platformAccessory(name, uuid);
                accessory.context.device = item.device;
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
        });
    }

    unregisterAccessories(devices) {
        this.accessories.forEach(accessory => {
            if (!devices.find(item => accessory.UUID === this.api.hap.uuid.generate(item.device.dsn))) {
                this.log.info("Unregister new accessory:", accessory.context.device.product_name);
                this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
        })
    }

    configureAccessory(accessory) {
        const dsn = accessory.context.device.dsn;
        const name = accessory.context.device.product_name;
        this.log.info('Configuring accessory:', name);
        let informationService = accessory.getService(this.Service.AccessoryInformation);
        if (!informationService) {
            informationService = accessory.addService(this.Service.AccessoryInformation);
        }
        informationService.setCharacteristic(this.Characteristic.Manufacturer, Rinnai.MANUFACTURER);
        informationService.setCharacteristic(this.Characteristic.Name, name);
        informationService.setCharacteristic(this.Characteristic.SerialNumber, dsn);
        informationService.setCharacteristic(this.Characteristic.Model, this.config.oem_model);

        let heaterCoolerService = accessory.getService(this.Service.HeaterCooler);
        if (!heaterCoolerService) {
            heaterCoolerService = accessory.addService(this.Service.HeaterCooler, name);
        }
        heaterCoolerService.getCharacteristic(this.Characteristic.Active)
            .on('get', this.handleHeaterActiveGet.bind(this, dsn))
            .on('set', this.handleHeaterActiveSet.bind(this, dsn));
        let validCurrentStates = this.getValidCurrentHeaterStates();
        heaterCoolerService.getCharacteristic(this.Characteristic.CurrentHeaterCoolerState)
            .on('get', this.handleCurrentHeaterStateGet.bind(this, dsn)).setProps({
                minValue: Math.min(...validCurrentStates),
                maxValue: Math.max(...validCurrentStates),
                validValues: validCurrentStates
            });
        let targetValidStates = this.getValidTargetHeaterStates();
        heaterCoolerService.getCharacteristic(this.Characteristic.TargetHeaterCoolerState)
            .on('get', this.handleTargetHeaterStateGet.bind(this))
            .setProps({
                minValue: Math.min(...targetValidStates),
                maxValue: Math.max(...targetValidStates),
                validValues: targetValidStates
            });
        heaterCoolerService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .on('get', this.handleHeatingThresholdTemperatureGet.bind(this, dsn));
        heaterCoolerService.getCharacteristic(this.Characteristic.HeatingThresholdTemperature)
            .on('get', this.handleHeatingThresholdTemperatureGet.bind(this, dsn))
            .on('set', this.handleHeatingThresholdTemperatureSet.bind(this, dsn))
            .setProps({
                minValue: 35,
                maxValue: 85,
            });

        let inUseSensorService = accessory.getService(name + ' In Use', dsn + 'INUSE');
        if (!inUseSensorService) {
            inUseSensorService = accessory.addService(this.Service.MotionSensor, name + ' In Use', dsn + 'INUSE');
        }
        inUseSensorService.getCharacteristic(this.Characteristic.MotionDetected)
            .on('get', this.handleWaterInUseGet.bind(this, dsn));

        let isReadySensorService = accessory.getService(name + ' Is Ready', dsn + 'ISREADY');
        if (!isReadySensorService) {
            isReadySensorService = accessory.addService(this.Service.MotionSensor, name + ' Is Ready', dsn + 'ISREADY');
        }
        isReadySensorService.getCharacteristic(this.Characteristic.MotionDetected)
            .on('get', this.handleWaterIsReadyGet.bind(this, dsn));
        this.log.info('Loaded:', name);

        this.accessories.push(accessory);
    }

    handleHeaterActiveGet(dsn, callback) {
        this.log.info('Triggered GET HeaterActive');
        this.ayla_api.getPropertyByDsn(dsn, Rinnai.PROPERTY_RECIRCULATE_MODE, (err, value) => {
            callback(err, value ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE);
        });
    }

    handleHeaterActiveSet(dsn, value, callback) {
        this.log.info('Triggered SET HeaterActive', value);
        this.ayla_api.createDataPointByDsn(dsn, Rinnai.PROPERTY_RECIRCULATE_MODE, value, callback);
    }


    getValidCurrentHeaterStates() {
        this.log.info('getValidCurrentHeaterStates');
        let validStates = [this.Characteristic.CurrentHeaterCoolerState.IDLE, this.Characteristic.CurrentHeaterCoolerState.HEATING];
        return validStates;
    }

    handleCurrentHeaterStateGet(dsn, callback) {
        this.log.info('Triggered GET CurrentHeaterCoolerState');
        this.ayla_api.getPropertyByDsn(dsn, Rinnai.PROPERTY_RECIRCULATE_MODE, (err, value) => {
            callback(err, value ? this.Characteristic.CurrentHeaterCoolerState.HEATING : this.Characteristic.CurrentHeaterCoolerState.IDLE);
        });
    }

    getValidTargetHeaterStates() {
        this.log.info('getValidTargetHeaterStates');
        let validStates = [this.Characteristic.TargetHeaterCoolerState.HEAT];
        return validStates;
    }

    handleTargetHeaterStateGet(callback) {
        this.log.info('Triggered GET TargetHeaterCoolerState');
        callback(null, this.Characteristic.TargetHeaterCoolerState.HEAT);
    }

    handleHeatingThresholdTemperatureGet(dsn, callback) {
        this.log.info('Triggered GET HeatingThresholdTemperature');
        this.ayla_api.getPropertyByDsn(dsn, Rinnai.PROPERTY_TEMPERATURE, (err, value) => {
            callback(err, fahrenheitToCelsius(value));
        });
    }

    handleHeatingThresholdTemperatureSet(dsn, value, callback) {
        this.log.info('Triggered SET HeatingThresholdTemperature', value);
        this.ayla_api.createDataPointByDsn(dsn, Rinnai.PROPERTY_TEMPERATURE, celsiusToFahrenheit(value), callback);
    }

    handleWaterInUseGet(dsn, callback) {
        this.log.info('Triggered GET WaterInUseGet');
        this.ayla_api.getPropertyByDsn(dsn, Rinnai.PROPERTY_WATER_FLOWING, callback);
    }

    handleWaterIsReadyGet(dsn, callback) {
        this.log.info('Triggered GET WaterIsReadyGet');
        this.ayla_api.getPropertyByDsn(dsn, Rinnai.PROPERTY_RECIRCULATE_MODE, (err, active) => {
            if (err || !active) {
                callback(err, false);
                return;
            }
            this.ayla_api.getPropertyByDsn(dsn, Rinnai.PROPERTY_TEMPERATURE, (err, target) => {
                if (err) {
                    callback(err, false);
                    return;
                }
                this.ayla_api.getPropertyByDsn(dsn, Rinnai.PROPERTY_OUTLET_TEMP, (err, value) => {
                    if (err) {
                        callback(err, false);
                        return;
                    }
                    callback(null, value >= target);
                });
            });
        });
    }
}

module.exports = RinnaiControlR;