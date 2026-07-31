import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { AuthService } from './auth.service';
import { User } from './entities/user.entity';

/**
 * Real Postgres + real bcrypt (the unit test mocks bcrypt) - proves a
 * password actually round-trips through hash/compare correctly and that
 * the unique-email constraint is enforced by the database, not just by a
 * mocked findOne.
 */
describe('AuthService (integration, real Postgres + bcrypt)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let service: AuthService;
  let jwtService: JwtService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    dataSource = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      entities: [User],
      synchronize: true,
    });
    await dataSource.initialize();
    jwtService = new JwtService({ secret: 'test-secret' });
  }, 120_000);

  afterAll(async () => {
    await dataSource?.destroy();
    await container?.stop();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE users CASCADE');
    service = new AuthService(dataSource.getRepository(User), jwtService);
  });

  it('registers a user with a real bcrypt hash, never storing the plaintext password', async () => {
    await service.register({ email: 'a@b.com', password: 'secret123' });

    const user = await dataSource
      .getRepository(User)
      .findOne({ where: { email: 'a@b.com' } });
    expect(user!.passwordHash).not.toBe('secret123');
    expect(user!.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(user!.roles).toEqual(['customer']);
  });

  it('rejects registering an email that already exists', async () => {
    await service.register({ email: 'a@b.com', password: 'secret123' });

    await expect(
      service.register({ email: 'a@b.com', password: 'other' }),
    ).rejects.toThrow(ConflictException);
  });

  it('logs in with the correct password and issues a JWT verifiable with the same secret', async () => {
    await service.register({ email: 'a@b.com', password: 'secret123' });

    const { accessToken } = await service.login({
      email: 'a@b.com',
      password: 'secret123',
    });

    const payload = jwtService.verify(accessToken) as {
      sub: string;
      email: string;
      roles: string[];
    };
    expect(payload.email).toBe('a@b.com');
    expect(payload.roles).toEqual(['customer']);
  });

  it('rejects login with the wrong password', async () => {
    await service.register({ email: 'a@b.com', password: 'secret123' });

    await expect(
      service.login({ email: 'a@b.com', password: 'wrong' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('me() returns the profile without the password hash', async () => {
    const { id } = await service.register({
      email: 'a@b.com',
      password: 'secret123',
    });

    const profile = await service.me(id);

    expect(profile).toEqual({
      id,
      email: 'a@b.com',
      roles: ['customer'],
      createdAt: expect.any(Date),
    });
    expect((profile as any).passwordHash).toBeUndefined();
  });
});
