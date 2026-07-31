import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

jest.mock('bcrypt');

describe('AuthService', () => {
  let service: AuthService;
  let userRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let jwtService: { sign: jest.Mock };

  beforeEach(() => {
    userRepository = {
      findOne: jest.fn(),
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'u1', ...data })),
    };
    jwtService = { sign: jest.fn().mockReturnValue('signed.jwt.token') };

    service = new AuthService(userRepository as any, jwtService as any);
    jest.clearAllMocks();
    userRepository.create.mockImplementation((data) => data);
    userRepository.save.mockImplementation((data) =>
      Promise.resolve({ id: 'u1', ...data }),
    );
    jwtService.sign.mockReturnValue('signed.jwt.token');
  });

  describe('register', () => {
    it('hashes the password and persists a customer with default role', async () => {
      userRepository.findOne.mockResolvedValue(null);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed-password');

      const result = await service.register({
        email: 'a@b.com',
        password: 'plain',
      });

      expect(bcrypt.hash).toHaveBeenCalledWith('plain', 10);
      expect(userRepository.create).toHaveBeenCalledWith({
        email: 'a@b.com',
        passwordHash: 'hashed-password',
        roles: ['customer'],
      });
      expect(result).toEqual({
        id: 'u1',
        email: 'a@b.com',
        roles: ['customer'],
      });
    });

    it('rejects registering an email that already exists', async () => {
      userRepository.findOne.mockResolvedValue({ id: 'existing' });

      await expect(
        service.register({ email: 'a@b.com', password: 'plain' }),
      ).rejects.toThrow(ConflictException);
      expect(userRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('signs a JWT with sub/email/roles on valid credentials', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        passwordHash: 'hashed-password',
        roles: ['customer'],
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.login({
        email: 'a@b.com',
        password: 'plain',
      });

      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: 'u1',
        email: 'a@b.com',
        roles: ['customer'],
      });
      expect(result).toEqual({ accessToken: 'signed.jwt.token' });
    });

    it('rejects when the user does not exist', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.login({ email: 'missing@b.com', password: 'plain' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects when the password does not match', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        passwordHash: 'hashed-password',
        roles: ['customer'],
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.login({ email: 'a@b.com', password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('me', () => {
    it('returns the profile without the password hash', async () => {
      const createdAt = new Date();
      userRepository.findOne.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        passwordHash: 'hashed-password',
        roles: ['customer'],
        createdAt,
      });

      const result = await service.me('u1');

      expect(result).toEqual({
        id: 'u1',
        email: 'a@b.com',
        roles: ['customer'],
        createdAt,
      });
    });
  });
});
