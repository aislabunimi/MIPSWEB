        .text
        .globl product
# product(a0, a1): a0 * a1 with repeated additions
product:
        li   $v0, 0
        move $t0, $a1
        bgez $t0, loop
        sub  $t0, $zero, $t0     # b < 0: product(-a, -b)
        sub  $a0, $zero, $a0
loop:   beqz $t0, done
        addd $v0, $v0, $a0
        addi $t0, $t0, -1
        j    loop
done:   jr   $ra
