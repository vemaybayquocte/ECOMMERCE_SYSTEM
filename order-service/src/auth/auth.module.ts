import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';

/**
 * Verification-only: order-service no longer issues tokens itself (the demo
 * API-key login is gone). Real login/register now lives in auth-service —
 * this module just needs the same JWT_SECRET to independently verify tokens
 * auth-service signed, stateless, no RPC back to auth-service required.
 */
@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'dev-secret-change-me'),
        signOptions: { expiresIn: '1h' },
      }),
    }),
  ],
  providers: [JwtStrategy],
  exports: [JwtModule, PassportModule],
})
export class AuthModule {}
