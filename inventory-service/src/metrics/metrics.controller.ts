import { Controller, Get, Header } from '@nestjs/common';
import { register } from './metrics.registry';

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', register.contentType)
  async getMetrics(): Promise<string> {
    return register.metrics();
  }
}
