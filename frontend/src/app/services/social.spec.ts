import { TestBed } from '@angular/core/testing';

import { Social } from './social';

describe('Social', () => {
  let service: Social;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Social);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
