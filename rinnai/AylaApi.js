const RestClient = require('node-rest-client').Client;
const Rinnai = require('./RinnaiConst.js');

const AYLA_US_SERVICE = 'https://ads-field.aylanetworks.com';
const AYLA_EU_SERVICE = 'https://ads-field-eu.aylanetworks.com';
const AYLA_CN_SERVICE = 'https://ads-field.ayla.com.cn';

const AYLA_GET_DEVICES = /*GET*/ '/apiv1/devices';
const AYLA_GET_DEVICE_BY_DSN = /*GET*/ '/apiv1/dsns/${dsn}';
const AYLA_GET_PROPERTY_BY_DSN = /*GET*/ '/apiv1/dsns/${dsn}/properties/${propName}';
const AYLA_CREATE_DATAPOINT_BY_DSN = /*POST*/ '/apiv1/dsns/${dsn}/properties/${propName}/datapoints';

const AYLA_GET_TOKENS = /*POST*/ '/users/sign_in';
const AYLA_GET_USER_PROFILE = /*GET*/ '/users/get_user_profile';
const AYLA_REFRESH_TOKEN = /*POST*/ '/users/refresh_token';

const REFRESH_TOKEN_GRACE_PERIOD = 43200000; // 12h

function errMsg(data, response) {
    return response.statusCode + ' ' + response.statusMessage + ': ' + (data && data.error);
}

class AylaApi extends RestClient {
    constructor(log) {
        super()
        this.service_domain = AYLA_US_SERVICE;
        this.log = log;
    }

    request(method, path, { vars = {}, headers = {}, data = {}, parameters = {} }, callback = (_data, _response) => { }) {
        const url = this.service_domain + path;
        const args = {
            data: data,
            path: vars,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                ...headers
            },
            parameters: parameters
        };
        this.log.info(method, url, args);
        switch (method) {
            case 'GET':
                this.get(url, args, callback);
                return;
            case 'POST':
                this.post(url, args, callback);
                return;
        }
    }

    authRequest(method, path, { vars = {}, data = {}, parameters = {} }, callback = (_data, _response) => { }) {
        if (!this.ACCESS_TOKEN) {
            callback({ error: 'Missing access token' }, { statusCode: -1, statusMessage: 'Skip ' + method + ' ' + path })
            return;
        }
        this.request(method, path, {
            vars: vars,
            headers: {
                'Authorization': 'auth_token ' + this.ACCESS_TOKEN
            },
            data: data,
            parameters: parameters
        }, callback);
    }

    handleDevices(callback, data, response) {
        this.log.info('handleDevices:', response.statusCode, data);
        if (response.statusCode != 200) {
            callback(Error(errMsg(data, response)));
            return;
        }
        callback(null, data);
    }

    getDevices(uuid, callback) {
        this.log.info('getDevices...');
        this.authRequest('GET', AYLA_GET_DEVICES, {
            parameters: {
                user_uuid: uuid
            }
        }, this.handleDevices.bind(this, callback));
    }

    handleDeviceByDsn(callback, data, response) {
        this.log.info('handleDeviceByDsn:', response.statusCode, data);
        if (response.statusCode != 200) {
            callback(Error(errMsg(data, response)));
            return;
        }
        this.log.info("Device data:", data.device);
        callback(null, data.device);
    }

    getDeviceByDsn(dsn, callback) {
        this.log.info('getDeviceByDsn...');
        this.authRequest('GET', AYLA_GET_DEVICE_BY_DSN, {
            vars: {
                'dsn': dsn
            }
        }, this.handleDeviceByDsn.bind(this, callback));
    }

    handlePropertyByDsn(callback, data, response) {
        this.log.info('handlePropertyByDsn:', response.statusCode, data);
        if (response.statusCode != 200) {
            callback(Error(errMsg(data, response)));
            return;
        }
        this.log.info("Property:", data.property.name, data.property.value);
        callback(null, data.property.value);
    }

    getPropertyByDsn(dsn, property, callback) {
        this.log.info('getPropertyByDsn...');
        this.authRequest('GET', AYLA_GET_PROPERTY_BY_DSN, {
            vars: {
                'dsn': dsn,
                'propName': property
            }
        }, this.handlePropertyByDsn.bind(this, callback));
    }

    handleDataPointCreationByDsn(callback, data, response) {
        this.log.info('handleDataPointCreationByDsn:', response.statusCode, data);
        if (response.statusCode != 201) {
            callback(Error(errMsg(data, response)));
            return;
        }
        callback(null)
    }

    createDataPointByDsn(dsn, property, value, callback) {
        this.log.info('createDataPointByDsn...');
        this.authRequest('POST', AYLA_CREATE_DATAPOINT_BY_DSN, {
            vars: {
                'dsn': dsn,
                'propName': property
            },
            data: {
                'datapoint': {
                    'value': value
                }
            }
        }, this.handleDataPointCreationByDsn.bind(this, callback));
    }

    handleUUID(callback, data, response) {
        this.log.info('handleUUID:', response.statusCode, data);
        if (response.statusCode != 200) {
            callback(Error(errMsg(data, response)));
            return;
        }
        this.log.info("UUID:", data.uuid);
        callback(null, data.uuid);
    }

    getUUID(callback) {
        this.log.info('getUUID...');
        this.authRequest('GET', AYLA_GET_USER_PROFILE, {}, this.handleUUID.bind(this, callback));
    }

    handleToken(callback, data, response) {
        this.log.info('handleToken:', response.statusCode, data);
        if (response.statusCode != 200) {
            if (response.statusCode == 401) {
                this.REFRESH_TOKEN = null
            }
            callback(errMsg(data, response));
            return;
        }
        this.ACCESS_TOKEN = data.access_token;
        this.REFRESH_TOKEN = data.refresh_token;
        this.TOKEN_EXPIRATION = (Date.now() + data.expires_in * 1000);
        this.log.info('Updated token expiring on', new Date(this.TOKEN_EXPIRATION).toString());
        callback(null);
    }

    getTokens(email, password, callback) {
        this.log.info('getTokens...');
        this.request('POST', AYLA_GET_TOKENS, {
            data: {
                'user': {
                    'email': email,
                    'password': password,
                    'application': {
                        'app_id': Rinnai.APP_ID,
                        'app_secret': Rinnai.APP_SECRET
                    }
                }
            }
        }, this.handleToken.bind(this, callback));
    }

    refreshToken(callback) {
        if (!this.REFRESH_TOKEN) {
            this.log.warn('refreshToken skipped: no refresh token.');
            callback(null);
            return;
        }
        if (this.TOKEN_EXPIRATION - REFRESH_TOKEN_GRACE_PERIOD > Date.now()) {
            this.log.info('refreshToken skipped: current access token expires on', new Date(this.TOKEN_EXPIRATION).toString());
            callback(null);
            return;
        }
        this.log.info('refreshToken...');
        this.request('POST', AYLA_REFRESH_TOKEN, {
            data: {
                'user': {
                    'refresh_token': this.REFRESH_TOKEN
                }
            }
        }, this.handleToken.bind(this, callback));
    }
}

AylaApi.REFRESH_TOKEN = '';
AylaApi.ACCESS_TOKEN = '';
AylaApi.TOKEN_EXPIRATION = 0;

module.exports = AylaApi;