import Fastify from 'fastify';
import authPlugin from './plugins/auth';     
import productRoutes from './routes/products';
import stockRoutes from './routes/stock';
import salesRoutes from './routes/sales';   // ← tambah
import reportsRoutes from './routes/reports';
import repackRoutes from './routes/repack';   // ← tambah import
import purchasesRoutes from './routes/purchases'; // <-- tambah ini
import posRoutes from './routes/pos';
//import usersRoutes from './routes/users';
import posHoldRoutes from './routes/posHold';
import posReturnRoutes from './routes/posReturn';
import reportsTransfersRoutes from './routes/reportsTransfers';
import authRoutes from './routes/auth';   
 
const app = Fastify({ logger: true });

app.get('/health', async () => ({ ok: true }));

app.register(authPlugin);
app.register(authRoutes);
app.register(productRoutes);
app.register(stockRoutes);
app.register(salesRoutes);                   // ← daftarkan
app.register(reportsRoutes);
app.register(repackRoutes);                   // ← daftar route
app.register(purchasesRoutes); 
app.register(posRoutes);
//app.register(usersRoutes);
app.register(posHoldRoutes);
app.register(posReturnRoutes);
app.register(reportsTransfersRoutes);


const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen({ port: PORT, host: '127.0.0.1' })
  .catch((err) => { app.log.error(err); process.exit(1); });
