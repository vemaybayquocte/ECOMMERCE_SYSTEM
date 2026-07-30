import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { LoginDto } from './dto/login.dto';

/**
 * Minimal starting point for real auth: exchanges a shared API key
 * (env-configured, no user database yet) for a signed JWT. A production
 * system would replace this with a real identity provider (Keycloak /
 * Auth0 / Cognito) or a proper user store with hashed credentials — this
 * just demonstrates the guard/verification mechanics end to end.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly demoApiKey: string;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.demoApiKey = this.configService.get<string>(
      'DEMO_API_KEY',
      'demo-secret-key',
    );
  }

  login(dto: LoginDto): { accessToken: string } {
    if (dto.apiKey !== this.demoApiKey) {
      this.logger.warn('Rejected login with invalid API key');
      throw new UnauthorizedException('Invalid API key');
    }

    const accessToken = this.jwtService.sign({ sub: 'api-client' });
    return { accessToken };
  }
}
