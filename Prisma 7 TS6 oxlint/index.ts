import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

const adapter = new PrismaLibSql({
  url: 'file:./dev.db',
})
const prisma = new PrismaClient({ adapter })

async function main() {
  const posts = await prisma.post.findMany({
    select: {
      id: true,
      name: true,
      nonExistentField: true,
    },
  })

  posts.forEach((post) => {
    console.log(post.name, post.nonExistentField)
  })
}

main()
