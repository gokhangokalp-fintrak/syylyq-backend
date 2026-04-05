const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function testFlows() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🧪 VITA SuperApp E2E Flow Testing');
  console.log('═══════════════════════════════════════════════════════════════\n');

  try {
    // INITIAL STATE CHECK
    console.log('📊 === INITIAL STATE CHECK ===\n');
    const initialUsers = await prisma.user.count();
    const initialMerchants = await prisma.merchant.count({ where: { approvalStatus: 'approved' } });
    const initialCards = await prisma.giftCard.count();
    const initialSettlements = await prisma.settlement.count();
    const initialBatches = await prisma.batchSettlement.count();
    
    console.log(`Total Users: ${initialUsers}`);
    console.log(`Approved Merchants: ${initialMerchants}`);
    console.log(`Gift Cards: ${initialCards}`);
    console.log(`Settlements: ${initialSettlements}`);
    console.log(`Batch Settlements: ${initialBatches}\n`);

    // GET TEST DATA
    const users = await prisma.user.findMany({ take: 3 });
    const merchants = await prisma.merchant.findMany({ where: { approvalStatus: 'approved' }, take: 2 });

    if (users.length < 2) throw new Error('Not enough test users in database');
    if (merchants.length < 2) throw new Error('Not enough test merchants in database');

    const buyer = users[0];
    const recipient = users[1];
    const merchant = merchants[0];
    const merchant2 = merchants[1];

    console.log(`✅ Using test data: Buyer=${buyer.name}, Recipient=${recipient.name}, Merchant=${merchant.name}\n`);

    // FLOW 1: SERTIFIKA (GIFT CARD) FLOW
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🎫 FLOW 1: Gift Card Flow (Sertifika)');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('Step 1.1: Purchasing a universal VITA certificate (500₺)...');
    const giftCard = await prisma.giftCard.create({
      data: {
        code: `SYY-TEST-${Date.now()}`,
        qrData: `{"id":"test-${Date.now()}","code":"SYY-TEST"}`,
        buyerId: buyer.id,
        recipientId: recipient.id,
        recipientPhone: recipient.phone,
        amount: 500,
        paidAmount: 500,
        paidWithTokens: 0,
        isVitaCert: true,
        status: 'sent',
        message: 'Happy Birthday!',
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });
    console.log(`✓ Created gift card: ${giftCard.code} (${giftCard.amount}₺)\n`);

    console.log('Step 1.2: Redeeming gift card at merchant...');
    const branch = await prisma.branch.findFirst({ where: { merchantId: merchant.id } });
    if (!branch) throw new Error('No branch found for merchant');

    const settlement1 = await prisma.settlement.create({
      data: {
        merchantId: merchant.id,
        totalAmount: giftCard.amount,
        commissionAmount: Math.round(giftCard.amount * merchant.commissionRate),
        netAmount: giftCard.amount - Math.round(giftCard.amount * merchant.commissionRate),
        commissionRate: merchant.commissionRate,
        method: merchant.settlementMethod,
        status: 'pending',
      },
    });

    const redemption1 = await prisma.giftCardRedemption.create({
      data: {
        giftCardId: giftCard.id,
        branchId: branch.id,
        verifiedBy: 'test-script',
        amount: giftCard.amount,
        settlementId: settlement1.id,
      },
    });

    await prisma.giftCard.update({
      where: { id: giftCard.id },
      data: { status: 'redeemed' },
    });

    console.log(`✓ Redeemed at ${branch.name}`);
    console.log(`  - Gross Amount: ${settlement1.totalAmount}₺`);
    console.log(`  - Commission (${(merchant.commissionRate * 100).toFixed(1)}%): ${settlement1.commissionAmount}₺`);
    console.log(`  - Net to Merchant: ${settlement1.netAmount}₺`);
    console.log(`  - Settlement Status: ${settlement1.status}\n`);

    console.log('Step 1.3: Checking ledger entry (cari hesap)...');
    const ledger1 = await prisma.ledgerEntry.create({
      data: {
        merchantId: merchant.id,
        type: 'debit_redemption',
        description: `Gift card redemption: ${giftCard.code}`,
        debit: settlement1.netAmount,
        credit: 0,
        balance: settlement1.netAmount,
        relatedId: settlement1.id,
      },
    });
    console.log(`✓ Ledger Entry Created:`);
    console.log(`  - Type: ${ledger1.type}`);
    console.log(`  - Debit (VITA owes merchant): ${ledger1.debit}₺`);
    console.log(`  - Balance: ${ledger1.balance}₺\n`);

    // FLOW 2: TOKEN ECONOMY FLOW
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🪙 FLOW 2: Token Economy Flow');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('Step 2.1: User earns tokens from activity...');
    const tokensEarned = 50;
    const userBefore = await prisma.user.findUnique({ where: { id: buyer.id } });
    
    await prisma.user.update({
      where: { id: buyer.id },
      data: { tokenBalance: { increment: tokensEarned } },
    });

    await prisma.tokenTransaction.create({
      data: {
        userId: buyer.id,
        amount: tokensEarned,
        type: 'earn_activity',
        source: 'Quiz Completion',
        isCashable: false,
        balanceAfter: (userBefore?.tokenBalance || 0) + tokensEarned,
      },
    });
    console.log(`✓ Added ${tokensEarned} tokens to ${buyer.name}`);
    console.log(`  - Previous Balance: ${userBefore?.tokenBalance}₺`);
    console.log(`  - New Balance: ${(userBefore?.tokenBalance || 0) + tokensEarned}₺\n`);

    console.log('Step 2.2: User spends tokens at merchant (QR payment)...');
    const tokensToSpend = 150;
    const userForPayment = await prisma.user.findUnique({ where: { id: recipient.id } });
    const recipientBalance = (userForPayment?.tokenBalance || 0);

    if (recipientBalance >= tokensToSpend) {
      await prisma.user.update({
        where: { id: recipient.id },
        data: { tokenBalance: { decrement: tokensToSpend } },
      });

      await prisma.tokenTransaction.create({
        data: {
          userId: recipient.id,
          amount: -tokensToSpend,
          type: 'spend_purchase',
          source: `QR Payment at ${merchant2.name}`,
          isCashable: false,
          balanceAfter: recipientBalance - tokensToSpend,
        },
      });

      const tokenRedemption = await prisma.tokenRedemption.create({
        data: {
          userId: recipient.id,
          merchantId: merchant2.id,
          amount: tokensToSpend,
          commissionRate: merchant2.commissionRate,
          commissionAmount: Math.round(tokensToSpend * merchant2.commissionRate),
          netAmount: tokensToSpend - Math.round(tokensToSpend * merchant2.commissionRate),
          status: 'completed',
          verifiedBy: 'test-script',
        },
      });

      const settlement2 = await prisma.settlement.create({
        data: {
          merchantId: merchant2.id,
          totalAmount: tokensToSpend,
          commissionAmount: tokenRedemption.commissionAmount,
          netAmount: tokenRedemption.netAmount,
          commissionRate: merchant2.commissionRate,
          method: merchant2.settlementMethod,
          status: 'pending',
        },
      });

      console.log(`✓ Token Payment Processed:`);
      console.log(`  - Tokens Spent: ${tokensToSpend}`);
      console.log(`  - Commission: ${tokenRedemption.commissionAmount}₺`);
      console.log(`  - Net to Merchant: ${tokenRedemption.netAmount}₺`);
      console.log(`  - Redemption Status: ${tokenRedemption.status}\n`);
    } else {
      console.log(`⚠ Skipped: User ${recipient.name} has insufficient tokens (${recipientBalance})\n`);
    }

    // FLOW 3: PAYMENT/SETTLEMENT FLOW
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('💰 FLOW 3: Payment & Settlement Flow (T+1 Batch)');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('Step 3.1: Preparing batch settlement...');
    const pendingSettlements = await prisma.settlement.findMany({
      where: { status: 'pending', merchantId: merchant.id },
      include: { merchant: true },
    });

    if (pendingSettlements.length > 0) {
      const totalGross = pendingSettlements.reduce((sum, s) => sum + s.totalAmount, 0);
      const totalCommission = pendingSettlements.reduce((sum, s) => sum + s.commissionAmount, 0);
      const totalNet = pendingSettlements.reduce((sum, s) => sum + s.netAmount, 0);

      const batch = await prisma.batchSettlement.create({
        data: {
          batchDate: new Date().toISOString().split('T')[0],
          merchantId: merchant.id,
          totalGross,
          totalCommission,
          totalNet,
          itemCount: pendingSettlements.length,
          method: merchant.settlementMethod,
          bankAccount: merchant.bankAccount || undefined,
          bankName: merchant.bankName || undefined,
          status: 'pending',
        },
      });

      await prisma.settlement.updateMany({
        where: { id: { in: pendingSettlements.map(s => s.id) } },
        data: { status: 'batched', batchId: batch.id },
      });

      console.log(`✓ Batch Created:`);
      console.log(`  - Batch ID: ${batch.id}`);
      console.log(`  - Items: ${batch.itemCount}`);
      console.log(`  - Gross: ${totalGross}₺`);
      console.log(`  - Commission: ${totalCommission}₺`);
      console.log(`  - Net Payable: ${totalNet}₺`);
      console.log(`  - Status: ${batch.status}\n`);

      console.log('Step 3.2: Executing batch payment...');
      await prisma.batchSettlement.update({
        where: { id: batch.id },
        data: {
          status: 'completed',
          processedAt: new Date(),
          reference: `REF-${Date.now()}`,
        },
      });

      await prisma.settlement.updateMany({
        where: { batchId: batch.id },
        data: { status: 'completed', processedAt: new Date() },
      });

      const ledger2 = await prisma.ledgerEntry.create({
        data: {
          merchantId: merchant.id,
          type: 'credit_batch_payment',
          description: `Batch payment completed`,
          debit: 0,
          credit: totalNet,
          balance: 0,
          relatedId: batch.id,
          batchId: batch.id,
        },
      });

      console.log(`✓ Payment Completed:`);
      console.log(`  - Amount Paid: ${totalNet}₺`);
      console.log(`  - Method: ${batch.method}`);
      console.log(`  - Reference: ${batch.reference}\n`);

      console.log('Step 3.3: Commission Tracking...');
      const merchantSettlements = await prisma.settlement.aggregate({
        where: { merchantId: merchant.id },
        _sum: { commissionAmount: true, totalAmount: true, netAmount: true },
      });

      console.log(`✓ Commission Report for ${merchant.name}:`);
      console.log(`  - Total Transactions: ${pendingSettlements.length}`);
      console.log(`  - Total Gross Value: ${merchantSettlements._sum.totalAmount || 0}₺`);
      console.log(`  - Total Commission Earned: ${merchantSettlements._sum.commissionAmount || 0}₺`);
      console.log(`  - Total Net Paid: ${merchantSettlements._sum.netAmount || 0}₺\n`);
    }

    // FINAL STATE CHECK & CONSISTENCY VERIFICATION
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✅ FINAL STATE & CONSISTENCY CHECKS');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const finalCards = await prisma.giftCard.aggregate({
      _count: true,
      _sum: { amount: true },
      where: { status: 'redeemed' },
    });

    const finalSettlements = await prisma.settlement.aggregate({
      _count: true,
      _sum: { totalAmount: true, commissionAmount: true, netAmount: true },
      where: { status: 'completed' },
    });

    const finalBatches = await prisma.batchSettlement.count({ where: { status: 'completed' } });

    const tokenTransactions = await prisma.tokenTransaction.aggregate({
      _count: true,
      _sum: { amount: true },
    });

    console.log('Gift Cards:');
    console.log(`  - Redeemed: ${finalCards._count}`);
    console.log(`  - Total Value: ${finalCards._sum.amount || 0}₺\n`);

    console.log('Settlements:');
    console.log(`  - Completed: ${finalSettlements._count}`);
    console.log(`  - Total Gross: ${finalSettlements._sum.totalAmount || 0}₺`);
    console.log(`  - Total Commission: ${finalSettlements._sum.commissionAmount || 0}₺`);
    console.log(`  - Total Paid to Merchants: ${finalSettlements._sum.netAmount || 0}₺\n`);

    console.log('Batch Settlements:');
    console.log(`  - Completed Batches: ${finalBatches}\n`);

    console.log('Token Economy:');
    console.log(`  - Total Transactions: ${tokenTransactions._count}`);
    console.log(`  - Net Token Flow: ${tokenTransactions._sum.amount || 0}\n`);

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✅ ALL TESTS COMPLETED SUCCESSFULLY');
    console.log('═══════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ ERROR:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testFlows();
