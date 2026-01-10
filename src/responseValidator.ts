import { Logger } from './logger';

// Minimum number of commas expected in a valid CSV response
const MIN_CSV_COMMAS = 4;

export class ResponseValidator {
  /**
   * Validates backend responses before they are cached.
   * Returns true if the response is valid and should be cached, false otherwise.
   */
  static validate(path: string, data: any): boolean {
    // JSON endpoints that should not be null
    const jsonEndpoints = ['/aggregates', '/soe', '/strings', '/freq', '/fans/pw', '/version'];
    
    if (jsonEndpoints.includes(path)) {
      return this.validateJsonEndpoint(path, data);
    }
    
    // CSV endpoint validation
    if (path === '/csv/v2') {
      return this.validateCsvEndpoint(path, data);
    }
    
    // For all other endpoints, accept the response
    return true;
  }

  private static validateJsonEndpoint(path: string, data: any): boolean {
    // Check if data is null or undefined
    if (data == null) {
      Logger.debug(`Response validation failed for ${path}: data is null or undefined`);
      return false;
    }

    // Check if data is the string "null"
    if (typeof data === 'string' && data === 'null') {
      Logger.debug(`Response validation failed for ${path}: data is string "null"`);
      return false;
    }

    // For valid JSON endpoints, data should be an object (includes arrays)
    // Note: In JavaScript, typeof array returns 'object'
    if (typeof data !== 'object') {
      Logger.debug(`Response validation failed for ${path}: data is not an object (type: ${typeof data})`);
      return false;
    }

    Logger.debug(`Response validation passed for ${path}`);
    return true;
  }

  private static validateCsvEndpoint(path: string, data: any): boolean {
    // CSV should be a string
    if (typeof data !== 'string') {
      Logger.debug(`Response validation failed for ${path}: data is not a string (type: ${typeof data})`);
      return false;
    }

    // Count commas - should have at least MIN_CSV_COMMAS
    const commaCount = (data.match(/,/g) || []).length;
    if (commaCount < MIN_CSV_COMMAS) {
      Logger.debug(`Response validation failed for ${path}: insufficient commas (found ${commaCount}, need at least ${MIN_CSV_COMMAS})`);
      return false;
    }

    Logger.debug(`Response validation passed for ${path}: ${commaCount} commas found`);
    return true;
  }
}
