        .data
msg:    .asciiz "The product is "
        .text
        .globl main
main:
        li   $v0, 5
        syscall
        move $t1, $v0        # a kept in a $t register...
        li   $v0, 5
        syscall
        move $a1, $v0
        move $a0, $t1
        jal  product
        mul  $t3, $t1, $a1   # ...and used after the call: wrong with CHAOS mode
        li   $v0, 4
        la   $a0, msg
        syscall
        li   $v0, 1
        move $a0, $t3
        syscall
        li   $v0, 10
        syscall
